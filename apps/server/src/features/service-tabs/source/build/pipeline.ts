import { access, constants, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { type BuildConfig, buildConfig, isSshRemote } from "@opsifier/contract";
import type { ActionContext } from "../../../../core/actions";
import type { AppDeps } from "../../../../core/context";
import { Redactor, ToolTimeoutError } from "../../../../core/tools";
import { getGithubToken } from "../../../github/service";
import { compileEnv } from "../../../services/compile/env";
import { builtImageName } from "../../../services/compile/names";
import type { ServiceRecord } from "../../../services/repo";
import { requireProject, type ServiceTarget, serviceDir } from "../../../services/service";
import { listDomainRows, toCompileDomains } from "../../domains/service";
import {
  SSH_KEY_CONTEXT,
  type StoredBuildState,
  type StoredGithubSource,
  type StoredGitSource,
} from "../stored";
import { unpackArchive, unwrapSingleFolder } from "./archive";
import { type BuildVariable, planBuild } from "./builders";
import { dockerCliEnv, isReservedBuildVariable } from "./environment";
import { checkoutRemote, type GitRemote } from "./git";
import { assertDirectory, assertFile, isInside, resolveInside, SourcePathError } from "./paths";

export interface BuildOptions {
  /** Skip every build cache. */
  force: boolean;
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

const knownHostsFile = (deps: Pick<AppDeps, "config">, target: ServiceTarget): string =>
  join(serviceDir(deps, target.projectName, target.serviceName), "known_hosts");

/** Where git reads from and with what credentials. A key or token is only ever used for its own kind of remote. */
export function gitRemoteOf(
  deps: Pick<AppDeps, "config" | "db" | "secrets">,
  target: ServiceTarget,
  source: StoredGithubSource | StoredGitSource,
  build: StoredBuildState,
): GitRemote {
  const hosts = knownHostsFile(deps, target);
  if (source.type === "github") {
    return {
      url: `https://github.com/${source.repository}.git`,
      sealedKey: null,
      token: getGithubToken(deps),
      knownHostsFile: hosts,
    };
  }
  return {
    url: source.url,
    sealedKey: isSshRemote(source.url) ? (build.sshKey?.sealedPrivateKey ?? null) : null,
    token: null,
    knownHostsFile: hosts,
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
      const remote = gitRemoteOf(deps, target, source, build);
      ctx.log(`Fetching ${source.type === "git" ? source.url : source.repository} at ${source.ref}`);
      const { sha } = await checkoutRemote(
        deps,
        remote,
        source.ref,
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

/** The variables of the build: the same ones the container gets, minus what would steer the tools. */
function buildVariables(
  deps: AppDeps,
  target: ServiceTarget,
  record: ServiceRecord,
  gitSha: string | null,
  log: (line: string) => void,
): BuildVariable[] {
  const project = requireProject(deps, target.projectName);
  const primary = toCompileDomains(listDomainRows(deps.db, target)).find((domain) => domain.primary);
  const merged = new Map<string, string>();
  for (const entry of compileEnv({
    project: target.projectName,
    service: target.serviceName,
    projectEnv: project.env,
    serviceEnv: record.spec.env,
    primaryHost: primary?.host ?? "",
    port: primary?.port ?? 80,
    gitSha,
  })) {
    const separator = entry.indexOf("=");
    merged.set(entry.slice(0, separator), entry.slice(separator + 1));
  }

  const skipped = [...merged.keys()].filter(isReservedBuildVariable);
  if (skipped.length > 0) {
    log(`Not passing to the build, these names steer the build tools: ${skipped.join(", ")}`);
  }
  return [...merged.entries()]
    .filter(([key]) => !isReservedBuildVariable(key))
    .map(([key, value]) => ({ key, value }));
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
  const quote = (value: string) =>
    /[\s#"'\\$]/.test(value) ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : value;
  const content = variables.map(({ key, value }) => `${key}=${quote(value)}\n`).join("");
  await writeFile(target, content, { mode: 0o644, flag: "wx" });
}

async function isExecutable(file: string): Promise<boolean> {
  return access(file, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/** A version the panel ships under its builders folder, or else whatever is on the PATH. */
async function resolveBuilderTool(
  deps: Pick<AppDeps, "config">,
  name: "nixpacks" | "railpack",
  version: string,
  log: (line: string) => void,
): Promise<string> {
  const versioned = join(deps.config.buildersDir, name, version, name);
  if (await isExecutable(versioned)) {
    return versioned;
  }
  log(`Using ${name} from the PATH: version ${version} is not installed under ${deps.config.buildersDir}.`);
  return name;
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

/** The build never receives these, but a stray line in its output must not be able to show them. */
function redactorFor(deps: Pick<AppDeps, "db" | "secrets">, record: ServiceRecord): Redactor {
  const redact = new Redactor();
  const { source, build } = record.spec;
  if (build.sshKey !== null) {
    redact.add(deps.secrets.unseal(build.sshKey.sealedPrivateKey, SSH_KEY_CONTEXT));
  }
  if (source?.type === "github") {
    const token = getGithubToken(deps);
    if (token !== null) {
      redact.addToken(token);
    }
  }
  return redact;
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

  const { code, gitSha } = await prepareCode(deps, target, record, ctx);

  const buildPath = source.type === "dockerfile" ? "" : relativePath(source.path);
  const context = await resolveInside(code, buildPath, "The build path");
  await assertDirectory(context, "The build path", `/${buildPath}`);

  const variables = buildVariables(deps, target, record, gitSha, ctx.log);
  if (build.envFilePath !== null) {
    ctx.log(`Writing the environment to ${build.envFilePath}`);
    await writeEnvFile(context, build.envFilePath, variables);
  }

  const config = await chooseBuild(
    source.type === "dockerfile" ? { type: "dockerfile", file: "" } : build.config,
    context,
    ctx.log,
  );

  let dockerfile: string | undefined;
  if (config.type === "dockerfile") {
    const file = config.file || "Dockerfile";
    dockerfile = await resolveInside(code, join(buildPath, file), "The Dockerfile");
    await assertFile(dockerfile, "The Dockerfile", file);
  }

  const image = builtImageName(target.projectName, target.serviceName);
  const workDir = await makeWorkDir(deps, "build-");
  try {
    const tool =
      config.type === "nixpacks" || config.type === "railpack"
        ? await resolveBuilderTool(deps, config.type, config.version, ctx.log)
        : undefined;
    const commands = planBuild(config, {
      image,
      context,
      dockerfile,
      force: options.force,
      variables,
      workDir,
      tool,
    });
    const env = {
      ...dockerCliEnv(deps),
      ...Object.fromEntries(variables.map(({ key, value }) => [key, value])),
    };

    const redact = redactorFor(deps, record);
    for (const command of commands) {
      ctx.log(`$ ${command.label}`);
      let result: Awaited<ReturnType<AppDeps["tools"]["run"]>>;
      try {
        result = await deps.tools.run({
          command: command.command,
          args: command.args,
          cwd: context,
          env,
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
        throw new Error(`The build failed with exit code ${result.exitCode}. Its log has the details.`);
      }
    }
  } finally {
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
