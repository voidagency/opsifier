import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { type BuildConfig, buildConfig, isPinnedBuilder, isSshRemote } from "@opsifier/contract";
import type { ActionContext } from "../../../../core/actions";
import type { AppDeps } from "../../../../core/context";
import { assertCliFeature, assertEngineSupported } from "../../../../core/docker";
import { ToolNotFoundError, ToolTimeoutError } from "../../../../core/tools";
import { getGithubToken } from "../../../github/service";
import { knownHostLines } from "../../../known-hosts/service";
import { rememberBuildCache, snapshotBuildCache } from "../../../server/docker-admin";
import { resolveEnvPairs } from "../../../services/compile/env";
import { builtImageName } from "../../../services/compile/names";
import { BUILD_SECRET_CONTEXT, envNames, openEnv } from "../../../services/env-store";
import { serviceRedactor } from "../../../services/masking";
import type { ServiceRecord } from "../../../services/repo";
import { requireProject, type ServiceTarget, serviceDir } from "../../../services/service";
import { listDomainRows, toCompileDomains } from "../../domains/service";
import { repositoryKey, sshHostOf } from "../identity";
import { claimDeployKey } from "../key-binding";
import type { StoredBuildState, StoredGithubSource, StoredGitSource } from "../stored";
import { unpackArchive, unwrapSingleFolder } from "./archive";
import {
  type BuildCommand,
  type BuildVariable,
  declaredBuildArgs,
  explainBuildFailure,
  forcedRebuildNote,
  needsBuildx,
  planBuild,
  REVISION_DOCKERFILE,
  revisionCommand,
} from "./builders";
import { dockerCliEnv, inheritedEnv, isReservedBuildVariable } from "./environment";
import { checkoutRemote, type GitRemote } from "./git";
import { assertDirectory, assertFile, isInside, resolveInside, SourcePathError } from "./paths";

export interface BuildOptions {
  /** Skip every build cache. */
  force: boolean;
  /** Build exactly this commit, instead of what the source's ref points at. */
  commit?: string;
}

export interface BuiltImage {
  image: string;
  /** The commit that was built, for sources that have one. */
  gitSha: string | null;
}

export const codeDir = (deps: Pick<AppDeps, "config">, target: ServiceTarget): string =>
  join(serviceDir(deps, target.projectName, target.serviceName), "code");

export const uploadedArchive = (deps: Pick<AppDeps, "config">, target: ServiceTarget): string =>
  join(serviceDir(deps, target.projectName, target.serviceName), "upload", "archive");

/**
 * Where git reads from and with what credentials. The panel's token is only for the repository it was
 * granted for, a deploy key only for the repository it is bound to, and neither follows a source
 * anywhere else.
 */
export function gitRemoteOf(
  deps: Pick<AppDeps, "db" | "secrets">,
  source: StoredGithubSource | StoredGitSource,
  build: StoredBuildState,
): GitRemote {
  if (source.type === "github") {
    const granted = source.tokenRepository?.toLowerCase() === source.repository.toLowerCase();
    return {
      url: `https://github.com/${source.repository}.git`,
      sealedKey: null,
      token: granted ? getGithubToken(deps) : null,
      knownHosts: "",
    };
  }
  if (!isSshRemote(source.url)) {
    return { url: source.url, sealedKey: null, token: null, knownHosts: "" };
  }
  const { host, port } = sshHostOf(source.url);
  const key = build.sshKey;
  const usable = key !== null && (key.boundTo === null || key.boundTo === repositoryKey(source.url));
  return {
    url: source.url,
    sealedKey: usable ? key.sealedPrivateKey : null,
    token: null,
    knownHosts: knownHostLines(deps, host, port),
  };
}

async function makeWorkDir(deps: Pick<AppDeps, "config">, prefix: string): Promise<string> {
  const parent = join(deps.config.dataDir, "tmp");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  return mkdtemp(join(parent, prefix));
}

/** The files a deploy just prepared replace the previous ones in one step. */
async function installCode(prepared: string, destination: string): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await rename(prepared, destination);
}

/** Puts the source's files in `code/`. Returns the commit they came from, if there is one. */
async function prepareCode(
  deps: AppDeps,
  target: ServiceTarget,
  record: ServiceRecord,
  ctx: ActionContext,
  commit: string | undefined,
): Promise<{ code: string; gitSha: string | null }> {
  const { source, build } = record.spec;
  const directory = serviceDir(deps, target.projectName, target.serviceName);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const code = join(directory, "code");
  // In the panel's temporary folder, which is emptied at boot: an interrupted build leaves nothing.
  const staging = await makeWorkDir(deps, "staging-");

  try {
    const tree = join(staging, "tree");
    let gitSha: string | null = null;
    let prepared = tree;

    if (source?.type === "dockerfile") {
      ctx.log("Writing the Dockerfile");
      await mkdir(tree, { recursive: true });
      await writeFile(join(tree, "Dockerfile"), source.dockerfile);
    } else if (source?.type === "upload") {
      ctx.log(`Unpacking ${source.fileName}`);
      await unpackArchive(deps, uploadedArchive(deps, target), tree, { signal: ctx.signal });
      prepared = await unwrapSingleFolder(tree);
    } else if (source?.type === "git" || source?.type === "github") {
      if (source.type === "git") {
        claimDeployKey(deps, target, source.url);
      }
      const remote = gitRemoteOf(deps, source, build);
      const wanted = commit ?? source.ref;
      ctx.log(`Fetching ${source.type === "git" ? source.url : source.repository} at ${wanted}`);
      const { sha } = await checkoutRemote(
        deps,
        remote,
        wanted,
        { gitDir: join(staging, "git"), workTree: tree },
        { signal: ctx.signal, onLine: ctx.log },
      );
      gitSha = sha === "" ? null : sha;
      ctx.log(`Checked out ${sha.slice(0, 12)}`);
    } else {
      throw new Error("This service has no source to build.");
    }

    await installCode(prepared, code);
    return { code, gitSha };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** What a build is given. The runtime environment is not part of it, unless this says so. */
interface BuildValues {
  variables: BuildVariable[];
  secrets: BuildVariable[];
  /** Which of the variables are only there because the service built before build variables existed. */
  inherited: ReadonlySet<string>;
}

const SEALED_REFERENCE = /\$\((?:secret|db)\.[A-Za-z0-9._-]+\)/;
/** Docker hands these to RUN steps without an ARG line asking for them. */
const PREDEFINED_ARGS = /^(?:HTTP_PROXY|HTTPS_PROXY|FTP_PROXY|NO_PROXY|ALL_PROXY)$/i;

/**
 * Only what was set aside for the build reaches it: the commit, the port, and its own variables and
 * secrets. A service that was building before these existed keeps getting its runtime variables, so that
 * it goes on building, except anything sealed, which never goes through a build argument.
 */
function buildValues(
  deps: AppDeps,
  target: ServiceTarget,
  record: ServiceRecord,
  gitSha: string | null,
  log: (line: string) => void,
): BuildValues {
  const project = requireProject(deps, target.projectName);
  const primary = toCompileDomains(listDomainRows(deps.db, target)).find((domain) => domain.primary);
  const { build } = record.spec;
  const placeholders = {
    project: target.projectName,
    service: target.serviceName,
    primaryHost: primary?.host ?? "",
    references: {},
    interpolate: record.spec.envInterpolation,
  };

  const merged = new Map<string, string>([["PORT", String(primary?.port ?? 80)]]);
  if (gitSha) {
    merged.set("GIT_SHA", gitSha);
  }

  const inherited = new Set<string>();
  if (build.inheritsRuntime) {
    const runtime = resolveEnvPairs({
      ...placeholders,
      projectEnv: openEnv(deps, project.sealedEnv),
      serviceEnv: openEnv(deps, record.spec.sealedEnv),
    });
    const sealed = runtime.filter(({ value }) => SEALED_REFERENCE.test(value)).map(({ key }) => key);
    if (sealed.length > 0) {
      log(`Not passing to the build, these hold sealed values: ${sealed.join(", ")}`);
    }
    for (const { key, value } of runtime) {
      if (!sealed.includes(key)) {
        merged.set(key, value);
        inherited.add(key);
      }
    }
  }

  for (const { key, value } of resolveEnvPairs({
    ...placeholders,
    projectEnv: "",
    serviceEnv: openEnv(deps, build.sealedVariables),
  })) {
    merged.set(key, value);
    inherited.delete(key);
  }

  const secrets = Object.entries(build.secrets).map(([key, secret]) => ({
    key,
    value: deps.secrets.unseal(secret.sealed, BUILD_SECRET_CONTEXT),
  }));
  for (const { key } of secrets) {
    merged.delete(key);
    inherited.delete(key);
  }

  const skipped = [...merged.keys(), ...secrets.map(({ key }) => key)].filter(isReservedBuildVariable);
  if (skipped.length > 0) {
    log(`Not passing to the build, these names steer the build tools: ${skipped.join(", ")}`);
  }
  return {
    variables: [...merged.entries()]
      .filter(([key]) => !isReservedBuildVariable(key))
      .map(([key, value]) => ({ key, value })),
    secrets: secrets.filter(({ key }) => !isReservedBuildVariable(key)),
    inherited,
  };
}

/**
 * Says what happens to a Dockerfile's ARG lines. An inherited variable it doesn't declare has no effect
 * on it, so it is simply left out: nothing can depend on it, and no ARG can start to record it later.
 */
function narrowToDockerfile(
  dockerfile: string,
  values: BuildValues,
  runtimeNames: readonly string[],
  log: (line: string) => void,
): BuildVariable[] {
  const declared = declaredBuildArgs(dockerfile);
  const given = new Set([...values.variables, ...values.secrets].map(({ key }) => key));
  const unmet = [...declared].filter((name) => runtimeNames.includes(name) && !given.has(name));
  if (unmet.length > 0) {
    log(
      `This Dockerfile declares ${unmet.join(", ")}, which only the container gets. Add what the build needs to its build variables.`,
    );
  }
  return values.variables.filter(
    ({ key }) => !values.inherited.has(key) || declared.has(key) || PREDEFINED_ARGS.test(key),
  );
}

function runtimeVariableNames(deps: AppDeps, target: ServiceTarget, record: ServiceRecord): string[] {
  const project = requireProject(deps, target.projectName);
  return [...envNames(openEnv(deps, project.sealedEnv)), ...envNames(openEnv(deps, record.spec.sealedEnv))];
}

function announceBuildValues(
  config: BuildConfig,
  variables: readonly BuildVariable[],
  values: BuildValues,
  log: (line: string) => void,
): void {
  log(`Build variables: ${variables.map(({ key }) => key).join(", ")}`);
  if (values.secrets.length > 0) {
    const names = values.secrets.map(({ key }) => key).join(", ");
    log(
      config.type === "nixpacks"
        ? `Not passing the build secrets ${names}: Nixpacks would write them into the image.`
        : `Build secrets: ${names}`,
    );
  }
  const inherited = variables.filter(({ key }) => values.inherited.has(key)).map(({ key }) => key);
  if (inherited.length > 0) {
    log(
      `Still passing runtime variables to this build, as before build variables existed: ${inherited.join(", ")}. ` +
        "A value a Dockerfile declares as ARG stays in the image's history. Choose what the build needs on the Environment tab.",
    );
  }
}

/** Writes dotenv content inside the source, replacing a link rather than following it. */
export async function writeEnvFile(
  root: string,
  file: string,
  variables: readonly BuildVariable[],
): Promise<void> {
  const target = join(root, file);
  const realRoot = await realpath(root);
  let parent = dirname(target);
  // The deepest folder that already exists decides whether the path stays inside.
  for (;;) {
    const exists = await lstat(parent).then(
      () => true,
      () => false,
    );
    if (exists) {
      break;
    }
    parent = dirname(parent);
  }
  if (!isInside(realRoot, await realpath(parent))) {
    throw new SourcePathError(`The environment file leaves the source: ${file}.`);
  }
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { force: true });
  await writeFile(target, dotenvText(variables), { mode: 0o644, flag: "wx" });
}

function dotenvText(variables: readonly BuildVariable[]): string {
  const quote = (value: string) =>
    /[\s#"'\\$]/.test(value) ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : value;
  return variables.map(({ key, value }) => `${key}=${quote(value)}\n`).join("");
}

/** Kept out of the context altogether: no COPY can reach it, and only a step that mounts it can read it. */
async function writeEnvFileOutsideContext(
  workDir: string,
  values: BuildValues,
  config: BuildConfig,
  log: (line: string) => void,
): Promise<string | undefined> {
  if (config.type !== "dockerfile") {
    log("Not writing the file of variables: only a Dockerfile can read one that stays out of the image.");
    return undefined;
  }
  const file = join(workDir, "env-file");
  await writeFile(file, dotenvText([...values.variables, ...values.secrets]), { mode: 0o600, flag: "wx" });
  log("The file of variables stays out of the build context. A step reads it as the build secret env-file");
  return file;
}

const BUILDER_NAMES = { nixpacks: "Nixpacks", railpack: "Railpack" } as const;
const NOT_REPLACED = "Nothing was built, and what is running was left alone.";

/**
 * The binary of exactly this version. There is no other one to fall back to: a build with a different
 * version from the one that was chosen would be a different build, and it would not say so anywhere.
 */
async function resolveBuilderTool(
  deps: Pick<AppDeps, "config" | "tools">,
  name: "nixpacks" | "railpack",
  version: string,
  log: (line: string) => void,
): Promise<string> {
  const tool = join(deps.config.buildersDir, name, version, name);
  const result = await deps.tools
    .run({ command: tool, args: ["--version"], env: inheritedEnv(), timeoutMs: 15_000 })
    .catch((error: unknown) => {
      if (error instanceof ToolNotFoundError) {
        return null;
      }
      throw error;
    });
  if (result === null || result.exitCode !== 0) {
    const installed = await readdir(join(deps.config.buildersDir, name)).catch(() => []);
    throw new Error(
      `${BUILDER_NAMES[name]} ${version} is not installed on this server, and a build never uses any other version. ${NOT_REPLACED} ${
        installed.length === 0
          ? "Install it, or choose another builder on the Source tab."
          : `Choose one of ${installed.sort().join(", ")} on the Source tab.`
      }`,
    );
  }
  log(`Using ${result.tail.at(-1) ?? `${BUILDER_NAMES[name]} ${version}`}`);
  return tool;
}

const DETECTED_NIXPACKS: BuildConfig = buildConfig.parse({ type: "nixpacks" });

/** What to run. With no settings: the build path's Dockerfile if there is one, otherwise Nixpacks. */
async function chooseBuild(
  saved: BuildConfig | null,
  context: string,
  log: (line: string) => void,
): Promise<BuildConfig> {
  if (saved !== null) {
    return saved;
  }
  const hasDockerfile = await lstat(join(context, "Dockerfile")).then(
    () => true,
    () => false,
  );
  log(hasDockerfile ? "Found a Dockerfile: building from it" : "No Dockerfile found: building with Nixpacks");
  return hasDockerfile ? { type: "dockerfile", file: "" } : DETECTED_NIXPACKS;
}

/** Records in the image itself which commit it came from, and lets go of the copy without it. */
async function stampRevision(
  deps: Pick<AppDeps, "docker">,
  build: { image: string; workDir: string },
  revision: string,
  run: (command: BuildCommand) => Promise<void>,
): Promise<void> {
  const unstamped = await deps.docker.inspectImage(build.image);
  await writeFile(join(build.workDir, REVISION_DOCKERFILE), `FROM ${build.image}\n`);
  await run(revisionCommand(build, revision));
  if (unstamped !== null && (await deps.docker.inspectImage(build.image))?.id !== unstamped.id) {
    await deps.docker.removeImage(unstamped.id).catch(() => undefined);
  }
}

function relativePath(path: string): string {
  return path.replace(/^\/+/, "");
}

/**
 * Turns a saved source into `opsifier/<project>/<service>:latest`. Everything it runs is cancelled
 * by the Action's signal and stopped by the build timeout, and any failure fails the deployment.
 */
export async function buildServiceImage(
  deps: AppDeps,
  target: ServiceTarget,
  record: ServiceRecord,
  ctx: ActionContext,
  options: BuildOptions,
): Promise<BuiltImage> {
  const { source, build } = record.spec;
  if (source === null || source.type === "image") {
    throw new Error("This source has nothing to build.");
  }
  await assertEngineSupported(deps.docker);

  const { code, gitSha } = await prepareCode(deps, target, record, ctx, options.commit);

  const buildPath = source.type === "dockerfile" ? "" : relativePath(source.path);
  const context = await resolveInside(code, buildPath, "The build path");
  await assertDirectory(context, "The build path", `/${buildPath}`);

  const values = buildValues(deps, target, record, gitSha, ctx.log);
  if (build.envFilePath !== null && build.envFileInImage) {
    ctx.log(`Writing the build variables to ${build.envFilePath}, in the build context`);
    await writeEnvFile(context, build.envFilePath, values.variables);
  }

  const config = await chooseBuild(
    source.type === "dockerfile" ? { type: "dockerfile", file: "" } : build.config,
    context,
    ctx.log,
  );

  let dockerfile: string | undefined;
  let variables = values.variables;
  if (config.type === "dockerfile") {
    const file = config.file || "Dockerfile";
    dockerfile = await resolveInside(code, join(buildPath, file), "The Dockerfile");
    await assertFile(dockerfile, "The Dockerfile", file);
    variables = narrowToDockerfile(
      await readFile(dockerfile, "utf8"),
      values,
      runtimeVariableNames(deps, target, record),
      ctx.log,
    );
  }
  announceBuildValues(config, variables, values, ctx.log);

  if (config.type === "buildpacks" && !isPinnedBuilder(config.builder)) {
    throw new Error(
      `${config.builder} is not pinned, so a later build could come out differently from this one. ${NOT_REPLACED} Choose a pinned builder on the Source tab.`,
    );
  }
  if (needsBuildx(config)) {
    await assertCliFeature(deps.docker, { tools: deps.tools, env: dockerCliEnv(deps) }, "buildx");
  }
  if (options.force) {
    ctx.log(forcedRebuildNote(config));
  }

  const image = builtImageName(target.projectName, target.serviceName);
  const workDir = await makeWorkDir(deps, "build-");
  const cacheBefore = await snapshotBuildCache(deps, ctx.signal);
  try {
    const tool =
      config.type === "nixpacks" || config.type === "railpack"
        ? await resolveBuilderTool(deps, config.type, config.version, ctx.log)
        : undefined;
    const secrets = config.type === "nixpacks" ? [] : values.secrets;
    const envFile =
      build.envFilePath !== null && !build.envFileInImage
        ? await writeEnvFileOutsideContext(workDir, values, config, ctx.log)
        : undefined;
    const commands = planBuild(config, {
      image,
      context,
      dockerfile,
      force: options.force,
      variables,
      secrets,
      envFile,
      workDir,
      tool,
      secretsHash: deps.secrets.fingerprint(
        JSON.stringify([...variables, ...secrets].sort((a, b) => a.key.localeCompare(b.key))),
        "build-values",
      ),
    });
    const given = {
      ...Object.fromEntries(variables.map(({ key, value }) => [key, value])),
      ...Object.fromEntries(secrets.map(({ key, value }) => [key, value])),
    };

    const redact = serviceRedactor(deps, target);
    const run = async (command: BuildCommand, step = commands.length) => {
      ctx.log(`$ ${command.label}`);
      let result: Awaited<ReturnType<AppDeps["tools"]["run"]>>;
      try {
        result = await deps.tools.run({
          command: command.command,
          args: command.args,
          cwd: context,
          env: { ...dockerCliEnv(deps), ...command.env, ...given },
          signal: ctx.signal,
          timeoutMs: deps.config.buildTimeoutMs,
          redact,
          onLine: ctx.log,
        });
      } catch (error) {
        if (error instanceof ToolTimeoutError) {
          throw new Error(`The build ran out of time after ${formatDuration(deps.config.buildTimeoutMs)}.`);
        }
        throw error;
      }
      if (result.exitCode !== 0) {
        throw new Error(
          `The build failed with exit code ${result.exitCode}, and what is running was left alone. ${explainBuildFailure(config, step, result.tail)}`,
        );
      }
    };
    for (const [step, command] of commands.entries()) {
      await run(command, step);
    }
    if (gitSha !== null) {
      await stampRevision(deps, { image, workDir }, gitSha, run);
    }
  } finally {
    await rememberBuildCache(deps, cacheBefore);
    await rm(workDir, { recursive: true, force: true });
  }

  ctx.log(
    `Built ${image}${gitSha === null ? "" : ` from ${gitSha.slice(0, 12)}`} (${relative(code, context) || "."})`,
  );
  return { image, gitSha };
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 2 ? `${minutes} minutes` : `${Math.round(ms / 1000)} seconds`;
}
