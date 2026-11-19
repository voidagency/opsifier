import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ComposeIssue } from "@opsifier/contract";
import { parse } from "yaml";
import type { ActionContext } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { conflict } from "../../core/errors";
import type { Redactor } from "../../core/tools";
import { foreignNetworkRefusal, prepareRoutedNetworks } from "../projects/network";
import { listDomainRows } from "../service-tabs/domains/service";
import { verifyTree } from "../service-tabs/source/build/archive";
import { isReservedBuildVariable } from "../service-tabs/source/build/environment";
import { checkoutRemote } from "../service-tabs/source/build/git";
import { resolveInside } from "../service-tabs/source/build/paths";
import { gitRemoteOf } from "../service-tabs/source/build/pipeline";
import { claimDeployKey } from "../service-tabs/source/key-binding";
import { resolveEnvPairs } from "../services/compile/env";
import { openEnv } from "../services/env-store";
import type { HostPort } from "../services/host-ports";
import { serviceRedactor } from "../services/masking";
import { type ServiceRecord, saveServiceSpec } from "../services/repo";
import { requireProject, requireService, type ServiceTarget, serviceDir } from "../services/service";
import { resolveReferences } from "../templates/references";
import { type BuildCheck, checkBuilds, type StackPull } from "./builds";
import { readPlainFile, readStackBytes, syncCheckout } from "./checkout";
import { type ContextRead, ignoreInputs, readContexts, writableInContext } from "./contexts";
import { foreignNetworks } from "./inspect";
import {
  COMPOSE_INLINE_FILE,
  composeCodeDir,
  composeManifestFile,
  composeOverrideFile,
  composeProject,
} from "./names";
import {
  type OverrideChild,
  overrideChildren,
  renderComposeOverride,
  resolvedOverrideChildren,
} from "./override";
import { fromStackFolder, heldByRunning, isBuildCache, linkedMount, ownFolderIssues } from "./own-folder";
import { assertStackPortsFree, resolvedHostPorts } from "./ports";
import {
  fileRefusal,
  linkedFileRefusal,
  linkedMountRefusal,
  runningHoldsRefusal,
  writableInContextRefusal,
} from "./refusals";
import {
  accessFacts,
  confirmationFingerprint,
  type FileDigest,
  inspectResolved,
  type LocalPath,
  type ResolvedInput,
} from "./resolved";
import { assertComposeSucceeded, type ComposeFiles, runCompose } from "./run";
import type { StoredCompose, StoredComposeGitSource } from "./spec";
import { containerState } from "./status";
import { inspectStackFiles, MAX_STACK_FILE_BYTES } from "./tree";

export interface PreparedStack {
  files: ComposeFiles;
  content: string;
}

export const hashCompose = (content: string): string => createHash("sha256").update(content).digest("hex");

/** Replaces one file atomically, never following a link that happens to sit at that path. */
async function writeFileAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, content, { mode, flag: "wx" });
  await rename(temporary, path);
}

/** The inline file. Writing it never touches anything else, so what a stack keeps in its folder stays. */
export async function writeInlineCompose(
  deps: Pick<AppDeps, "config">,
  target: ServiceTarget,
  content: string,
): Promise<void> {
  const code = composeCodeDir(deps, target);
  await mkdir(code, { recursive: true, mode: 0o755 });
  await writeFileAtomic(join(code, COMPOSE_INLINE_FILE), content, 0o644);
}

async function readManifest(file: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** A Git stack's Compose file, read as a plain file through folders alone, so that nothing can hold the deploy. */
async function readComposeFile(code: string, composeFile: string): Promise<string> {
  const content = await readPlainFile(await realpath(code), composeFile, MAX_STACK_FILE_BYTES);
  if (content === null) {
    throw conflict(
      "compose_invalid",
      "The Compose file of this stack can't be read as a plain file of at most 1 MiB, reached through folders alone.",
    );
  }
  return content;
}

async function prepareGit(
  deps: AppDeps,
  target: ServiceTarget,
  record: ServiceRecord,
  source: StoredComposeGitSource,
  ctx: ActionContext,
  commit: string | undefined,
): Promise<PreparedStack> {
  const parent = join(deps.config.dataDir, "tmp");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, "compose-"));
  const code = composeCodeDir(deps, target);
  try {
    claimDeployKey(deps, target, source.url);
    const wanted = commit ?? source.ref;
    ctx.phase("fetch");
    ctx.log(`Fetching ${source.url} at ${wanted}`);
    const tree = join(staging, "tree");
    const { sha } = await checkoutRemote(
      deps,
      gitRemoteOf(
        deps,
        { type: "git", url: source.url, ref: source.ref, path: source.path },
        record.spec.build,
      ),
      wanted,
      { gitDir: join(staging, "git"), workTree: tree },
      { signal: ctx.signal, onLine: ctx.log },
    );
    ctx.log(`Checked out ${sha.slice(0, 12)}`);
    await verifyTree(tree);
    // The checkout tracks what it brought, so a redeploy keeps whatever the stack wrote itself.
    const manifest = composeManifestFile(deps, target);
    const incoming = await syncCheckout(tree, code, await readManifest(manifest));
    await writeFileAtomic(manifest, JSON.stringify(incoming), 0o600);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  const relativePath = source.path.replace(/^\/+/, "");
  const projectDirectory = await resolveInside(code, relativePath, "The build path");
  const composeFile = await resolveInside(projectDirectory, source.file, "The Compose file");
  return {
    content: await readComposeFile(code, composeFile),
    files: { projectDirectory, composeFile, overrideFile: composeOverrideFile(deps, target) },
  };
}

/** Puts the file the deploy will use on disk. Everything else in the stack's folder is left alone. */
export async function prepareStack(
  deps: AppDeps,
  target: ServiceTarget,
  record: ServiceRecord,
  compose: StoredCompose,
  ctx: ActionContext,
  commit?: string,
): Promise<PreparedStack> {
  const { source } = compose;
  if (source === null) {
    throw new Error("This stack has no Compose file yet.");
  }
  await mkdir(serviceDir(deps, target.projectName, target.serviceName), { recursive: true, mode: 0o700 });
  if (source.type === "git") {
    return prepareGit(deps, target, record, source, ctx, commit);
  }
  await writeInlineCompose(deps, target, source.content);
  const code = composeCodeDir(deps, target);
  return {
    content: source.content,
    files: {
      projectDirectory: await realpath(code),
      composeFile: await resolveInside(code, COMPOSE_INLINE_FILE, "The Compose file"),
      overrideFile: composeOverrideFile(deps, target),
    },
  };
}

/** Every variable a stack gets, with its references resolved. */
export function stackEnvPairs(
  deps: Pick<AppDeps, "db" | "secrets">,
  target: ServiceTarget,
  record: ServiceRecord,
): { pairs: ReturnType<typeof resolveEnvPairs>; references: Readonly<Record<string, string>> } {
  const project = requireProject(deps, target.projectName);
  const primary = listDomainRows(deps.db, target).find((row) => row.isPrimary);
  const references = resolveReferences(deps, target, record.spec);
  return {
    references,
    pairs: resolveEnvPairs({
      project: target.projectName,
      service: target.serviceName,
      projectEnv: openEnv(deps, project.sealedEnv),
      serviceEnv: openEnv(deps, record.spec.sealedEnv),
      primaryHost: primary?.host ?? "",
      references,
      interpolate: record.spec.envInterpolation,
    }),
  };
}

/** The variables Compose interpolates, resolved at deploy like a container's. */
export function stackVariables(
  deps: AppDeps,
  target: ServiceTarget,
  record: ServiceRecord,
  log: (line: string) => void,
): Record<string, string> {
  const { pairs } = stackEnvPairs(deps, target, record);
  const variables: Record<string, string> = {};
  const skipped: string[] = [];
  for (const { key, value } of pairs) {
    if (isReservedBuildVariable(key)) {
      skipped.push(key);
    } else {
      variables[key] = value;
    }
  }
  if (skipped.length > 0) {
    log(`Not passing these variables, they steer Compose itself: ${skipped.join(", ")}`);
  }
  return variables;
}

const ENV_FILE_MARK = "# Written by Opsifier. Edit the stack's environment instead.";

const quoteEnv = (value: string) =>
  /[\s#"'\\$]/.test(value) ? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : value;

/**
 * Writes `.env` beside the Compose file, or removes a `.env` the panel wrote earlier. A `.env` that
 * came from the repository is not touched when the switch is off.
 */
export async function applyEnvFile(
  projectDirectory: string,
  enabled: boolean,
  variables: Readonly<Record<string, string>>,
): Promise<void> {
  const path = join(projectDirectory, ".env");
  if (enabled) {
    const content = Object.entries(variables)
      .map(([key, value]) => `${key}=${quoteEnv(value)}\n`)
      .join("");
    await rm(path, { force: true });
    await writeFile(path, `${ENV_FILE_MARK}\n${content}`, { mode: 0o600, flag: "wx" });
    return;
  }
  // Read only as a plain file of the folder: a link or a pipe there is not one the panel wrote.
  const previous = await readPlainFile(projectDirectory, path, MAX_STACK_FILE_BYTES);
  if (previous?.startsWith(ENV_FILE_MARK)) {
    await rm(path, { force: true });
  }
}

/** The project's networks, which the override puts every child on. They are attachable for this reason. */
export const prepareStackNetwork = (
  deps: AppDeps,
  target: ServiceTarget,
  ctx: Pick<ActionContext, "log">,
): Promise<void> => prepareRoutedNetworks(deps, target.projectName, ctx.log);

export interface StackDeployOptions {
  /** Skips the build cache and pulls fresh images. */
  force?: boolean;
  /** Check out exactly this commit, instead of what the source's ref points at. */
  commit?: string;
}

function assertRunnable(content: string): { services: Record<string, unknown> } {
  const parsed: unknown = parse(content, { merge: true });
  const services = (parsed as { services?: unknown } | null)?.services;
  if (typeof services !== "object" || services === null) {
    throw new Error("This Compose file defines no services.");
  }
  return { services: services as Record<string, unknown> };
}

/** What a child said just before it died, in its own words. */
async function logChildTail(
  deps: Pick<AppDeps, "config" | "docker" | "tools">,
  target: ServiceTarget,
  child: string,
  redact: Redactor,
  signal: AbortSignal,
  log: (line: string) => void,
): Promise<void> {
  log(`Last output of ${child}:`);
  await runCompose(deps, target, ["logs", "--no-color", "--tail", "30", child], {
    signal,
    redact,
    onLine: (line) => log(`  ${line}`),
  }).catch((error: unknown) => {
    log(`Could not read its logs: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/**
 * Waits for every child to come up and stay up through the rollout's stability window. Children that
 * exit cleanly in that window are treated as finished, and anything else that isn't running is a
 * failure of this deploy, reported by name, with the child's own last words.
 */
export async function watchStack(
  deps: Pick<AppDeps, "config" | "docker" | "rollout" | "tools">,
  target: ServiceTarget,
  ctx: ActionContext,
  redact: Redactor,
): Promise<string[]> {
  const project = composeProject(target);
  const { pollMs, stableMs, timeoutMs } = deps.rollout;
  const started = performance.now();
  let settledAt: number | null = null;
  const logged = new Set<string>();

  for (;;) {
    ctx.signal.throwIfAborted();
    const containers = await deps.docker.listComposeContainers(project);
    if (containers.length === 0) {
      throw new Error("Compose created no containers for this stack.");
    }

    const facts = { stopped: false, completedChildren: [] as string[] };
    const states = containers.map((container) => ({ container, state: containerState(container, facts) }));
    for (const { container, state } of states) {
      const line = `${container.child} (${container.name}): ${state}`;
      if (!logged.has(line)) {
        logged.add(line);
        ctx.log(line);
      }
    }

    const crashed = states.find(
      ({ container, state }) => state === "failed" && container.state !== "restarting",
    );
    if (crashed !== undefined) {
      await logChildTail(deps, target, crashed.container.child, redact, ctx.signal, ctx.log);
      throw new Error(
        `${crashed.container.child} exited with code ${crashed.container.exitCode ?? "unknown"}.`,
      );
    }

    const waiting = states.filter(
      ({ state }) => state === "starting" || state === "failed" || state === "unhealthy",
    );
    const now = performance.now();
    if (waiting.length === 0) {
      settledAt ??= now;
      if (now - settledAt >= stableMs) {
        const completed = states
          .filter(({ container, state }) => state === "stopped" && container.exitCode === 0)
          .map(({ container }) => container.child);
        const down = states.filter(({ container, state }) => state === "stopped" && container.exitCode !== 0);
        if (down[0] !== undefined) {
          throw new Error(`${down[0].container.child} stopped during the deploy.`);
        }
        return [...new Set(completed)];
      }
    } else {
      settledAt = null;
    }

    if (now - started > timeoutMs) {
      const first = waiting[0];
      if (first !== undefined) {
        await logChildTail(deps, target, first.container.child, redact, ctx.signal, ctx.log);
        throw new Error(`${first.container.child} did not settle in time (${first.state}).`);
      }
      throw new Error("The stack did not settle in time.");
    }
    await sleep(pollMs, undefined, { signal: ctx.signal });
  }
}

/** Layer-by-layer pull progress repeats for every chunk. The steps worth reading afterwards stay in the log. */
const PULL_PROGRESS =
  /^\s*[0-9a-f]{12} (?:Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)/;

/** The files of the stack as the last save or checkout left them, without fetching anything. */
export async function stackFilesOnDisk(
  deps: Pick<AppDeps, "config">,
  target: ServiceTarget,
  compose: StoredCompose,
): Promise<ComposeFiles> {
  const { source } = compose;
  if (source === null) {
    throw conflict("service_has_no_source", "Save a Compose file first.");
  }
  const code = composeCodeDir(deps, target);
  const overrideFile = composeOverrideFile(deps, target);
  if (source.type === "inline") {
    return {
      projectDirectory: await realpath(code),
      composeFile: await resolveInside(code, COMPOSE_INLINE_FILE, "The Compose file"),
      overrideFile,
    };
  }
  const projectDirectory = await resolveInside(code, source.path.replace(/^\/+/, ""), "The build path");
  return {
    projectDirectory,
    composeFile: await resolveInside(projectDirectory, source.file, "The Compose file"),
    overrideFile,
  };
}

async function writeOverride(
  deps: Pick<AppDeps, "config">,
  target: ServiceTarget,
  record: ServiceRecord,
  children: readonly OverrideChild[],
): Promise<void> {
  await writeFileAtomic(
    composeOverrideFile(deps, target),
    renderComposeOverride({
      project: target.projectName,
      service: target.serviceName,
      id: record.id,
      qualified: composeProject(target),
      children,
    }),
    0o600,
  );
}

/**
 * Marks every child of the file on the page as the panel's and puts it on the project's networks.
 * Written before Compose reads the stack, and again from what it resolved before anything starts.
 */
export const writeStackOverride = (
  deps: Pick<AppDeps, "config">,
  target: ServiceTarget,
  record: ServiceRecord,
  content: string,
): Promise<void> => writeOverride(deps, target, record, overrideChildren(assertRunnable(content)));

/** What a stack reaches on the server, and what stops it outright, read through Compose with nothing started. */
export interface StackAccess {
  /** What no confirmation allows: another project's network, a program Compose would run, a file outside the stack. */
  refusal: Error | null;
  /** Every way the stack reaches the server, as Compose resolved it. */
  access: ComposeIssue[];
  /** The host ports it publishes, as Compose resolved them. */
  published: HostPort[];
  /** Every child Compose resolved, included ones among them, as the override that starts them marks it. */
  children: OverrideChild[];
  /** What the children mount from the stack's own folder, walked again right before they start. */
  mounts: LocalPath[];
  /** What the builds read or write in the stack's own folder, walked again right before they run. */
  inputs: ResolvedInput[];
  /** What each build walks as a context, and what it never walks there. */
  contexts: ContextRead[];
  /** The volumes the stack has Compose make, as it would make them. */
  volumes: DeclaredVolume[];
  /** Every file Compose reads to know what the stack is, by absolute path. */
  files: string[];
  /** Images the stack takes from the store by name, as a mount or a build context, pulled before it starts. */
  pulls: StackPull[];
  /** What whoever deploys should read about its builds. */
  notes: string[];
  /** What a confirmation of that access is bound to. See `confirmationFingerprint`. */
  fingerprint: string;
}

const isInside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What each file the stack is read from holds right now, by its path from the stack's folder. A file
 * that isn't there counts as such, so that one appearing later asks again too.
 */
async function digestFiles(projectDirectory: string, paths: readonly string[]): Promise<FileDigest[]> {
  const root = await realpath(projectDirectory);
  const digests = new Map<string, string>();
  for (const path of paths) {
    const shown = fromStackFolder(root, path);
    if (shown === null || digests.has(shown)) {
      continue;
    }
    // Walked for links already. Read as a plain file only, so that nothing can hold the deploy.
    const content = await readStackBytes(root, path, MAX_STACK_FILE_BYTES);
    if (content === "not_plain" || content === "too_large") {
      throw conflict(
        "compose_invalid",
        `This Compose file can't run: ./${shown}, a file the stack is read from, is ${content === "too_large" ? "larger than 1 MiB" : "not a plain file"}.`,
      );
    }
    digests.set(shown, content === "missing" ? "absent" : createHash("sha256").update(content).digest("hex"));
  }
  return [...digests];
}

/**
 * Docker follows links when it mounts a path and Compose when it reads one, so a path inside the stack
 * counts for where it really leads. A link the stack wrote in its own folder can lead anywhere.
 */
async function linksOut(paths: readonly LocalPath[], projectDirectory: string): Promise<ComposeIssue[]> {
  const root = await realpath(projectDirectory);
  const found: ComposeIssue[] = [];
  for (const { service, path } of paths) {
    let existing = path;
    let rest: string[] = [];
    for (;;) {
      const exists = await lstat(existing).then(
        () => true,
        () => false,
      );
      const parent = dirname(existing);
      if (exists || parent === existing) {
        break;
      }
      rest = [basename(existing), ...rest];
      existing = parent;
    }
    const real = join(await realpath(existing).catch(() => existing), ...rest);
    if (!isInside(root, real)) {
      found.push({ severity: "host", code: "host_path", service, detail: `${path} -> ${real}` });
    }
  }
  return found;
}

/** What Compose itself makes of the stack: every file merged in, every variable and path filled in. */
async function resolveWithCompose(
  deps: AppDeps,
  target: ServiceTarget,
  files: ComposeFiles,
  variables: Readonly<Record<string, string>>,
  redact: Redactor,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const output = `${files.overrideFile}.${randomBytes(6).toString("hex")}.resolved`;
  const read = (keepEnvFiles: boolean) =>
    runCompose(
      deps,
      target,
      [
        "config",
        "--format",
        "json",
        // Env files are kept as paths, so that where they are read from can be judged too.
        ...(keepEnvFiles ? ["--no-env-resolution"] : []),
        "--output",
        output,
      ],
      { files, variables, redact, signal, timeoutMs: 60_000 },
    );
  try {
    let result = await read(true);
    // A Compose older than that option still reads the stack. The files it brings in were checked
    // before, env files among them.
    if (result.exitCode !== 0 && result.tail.some((line) => line.includes("no-env-resolution"))) {
      result = await read(false);
    }
    assertComposeSucceeded("Reading the Compose file", result);
    return JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>;
  } finally {
    await rm(output, { force: true });
  }
}

/**
 * Docker resolves a mount's source again, links included, each time it starts a child, so every part
 * of it from the stack's code folder down has to be a real folder. No container can write those, so
 * what this finds stays true for as long as the stack runs.
 */
async function assertMountsReal(
  deps: Pick<AppDeps, "config">,
  target: ServiceTarget,
  { mounts, inputs }: Pick<StackAccess, "mounts" | "inputs">,
): Promise<void> {
  const linked = await linkedMount(await realpath(composeCodeDir(deps, target)), [...mounts, ...inputs]);
  if (linked !== null) {
    throw linkedMountRefusal(linked);
  }
}

/**
 * Compose pulls a child's image itself, but not an image a child mounts or a build names as a context:
 * those come from the store as it is, where another project may have pulled a private image under the
 * same name. Pulled here first, without credentials, the name holds what its registry gives anyone.
 */
async function pullStackImages(
  deps: Pick<AppDeps, "docker">,
  pulls: readonly StackPull[],
  ctx: Pick<ActionContext, "log" | "signal">,
): Promise<void> {
  for (const { service, image, use } of pulls) {
    ctx.log(`Pulling ${image}, which ${service} ${use === "volume" ? "mounts" : "builds with"}`);
    try {
      await deps.docker.pullImage(image, { signal: ctx.signal });
    } catch (error) {
      throw conflict(
        "compose_invalid",
        `${image}, which ${service} ${use === "volume" ? "mounts" : "builds with"}, could not be pulled from its registry (${error instanceof Error ? error.message : String(error)}). A stack can only use an image a registry gives anyone, or one it builds.`,
      );
    }
  }
}

/** A volume a stack has Compose make, as it would make it. */
export interface DeclaredVolume {
  key: string;
  name: string;
  driver: string;
  options: Record<string, string>;
}

/** The volumes of what Compose resolved that Compose makes itself, rather than finds by name. */
function declaredVolumes(config: Record<string, unknown>, stack: string): DeclaredVolume[] {
  const volumes = isRecord(config.volumes) ? config.volumes : {};
  return Object.entries(volumes).flatMap(([key, value]) => {
    const declared = isRecord(value) ? value : {};
    if (declared.external !== undefined && declared.external !== false) {
      return [];
    }
    const options = isRecord(declared.driver_opts) ? declared.driver_opts : {};
    return [
      {
        key,
        name: typeof declared.name === "string" ? declared.name : `${stack}_${key}`,
        driver: typeof declared.driver === "string" ? declared.driver : "local",
        options: Object.fromEntries(Object.entries(options).map(([name, option]) => [name, String(option)])),
      },
    ];
  });
}

const sameOptions = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([key, value]) => b[key] === value);

/**
 * Compose keeps a volume as it was made, whatever the file says now, and Docker reports a volume that
 * binds a folder by the volume's own folder: so a stack may not deploy while a volume it has binds a
 * folder of the server, or was made with other options than the file gives it now. Removing such a
 * volume, once the stack is stopped, is what lets the file decide again.
 */
async function assertVolumesAsDeclared(
  deps: Pick<AppDeps, "docker">,
  target: ServiceTarget,
  declared: readonly DeclaredVolume[],
): Promise<void> {
  const stack = composeProject(target);
  const volumes = (await deps.docker.listVolumes()).filter(
    (volume) => volume.labels["com.docker.compose.project"] === stack,
  );
  for (const volume of volumes) {
    const options = volume.options ?? {};
    const binds = String(options.o ?? "")
      .split(",")
      .some((option) => ["bind", "rbind"].includes(option.trim()));
    const wanted = declared.find(
      (entry) => entry.name === volume.name || entry.key === volume.labels["com.docker.compose.volume"],
    );
    const differs =
      wanted !== undefined && (wanted.driver !== volume.driver || !sameOptions(wanted.options, options));
    if (binds || differs) {
      throw conflict(
        "compose_invalid",
        binds
          ? `This stack can't deploy while its volume ${volume.name} binds a folder of the server${options.device === undefined ? "" : ` (${options.device})`}, which Compose would keep using as it was made. Stop the stack and remove that volume, then deploy.`
          : `This stack can't deploy while its volume ${volume.name} was made with other options than the file now gives it, which Compose would keep using as it was made. Stop the stack and remove that volume, then deploy.`,
      );
    }
  }
}

/** A container in any of these can act while Compose pulls and builds. Stopping it is what ends that. */
const ACTIVE_STATES = new Set(["running", "restarting", "paused"]);

/**
 * The stack's running containers keep their mounts until `up` replaces them, after it has pulled and
 * built everything, so none of them may hold what the new configuration mounts, is read from or builds
 * from. A stack deployed before these rules, or whose file has changed, can be stopped first.
 */
async function assertNothingRunningHolds(
  deps: Pick<AppDeps, "config" | "docker">,
  target: ServiceTarget,
  stack: Pick<StackAccess, "mounts" | "files" | "inputs" | "contexts">,
): Promise<void> {
  const running = (await deps.docker.listComposeContainers(composeProject(target)))
    .filter((container) => ACTIVE_STATES.has(container.state))
    .flatMap((container) =>
      (container.binds ?? []).map(({ source, rw }) => ({
        child: container.child,
        container: container.name,
        source,
        rw,
      })),
    );
  const root = await realpath(composeCodeDir(deps, target));
  // Docker reports a bind by the path it was given, not where a link on that path led when the
  // container started: one started through a link, as was allowed before, may hold anything.
  for (const bind of running) {
    const linked = await linkedMount(root, [{ service: bind.child, path: bind.source }]);
    if (linked !== null && linked.kind === "link") {
      throw conflict(
        "compose_invalid",
        `This stack can't deploy while ${bind.child} (${bind.container}) runs: it mounts ./${linked.path}, which goes through a link at ./${linked.at}, so what it holds is not what its path says. Stop the stack, then deploy.`,
      );
    }
  }
  const held = heldByRunning(root, running, {
    mounts: stack.mounts.map((mount) => mount.path),
    files: stack.files,
    inputs: stack.inputs.map((input) => input.path),
    caches: stack.inputs.filter(isBuildCache).map((input) => input.path),
    contexts: stack.contexts,
  });
  if (held !== null) {
    throw runningHoldsRefusal(held);
  }
}

/**
 * Reads a stack the way a deploy is about to run it. The files it brings in are checked first, since
 * Compose reads or fetches what they name as it loads them. Then what Compose resolved is held to the
 * same rules as the file on the page: an `include`, an `extends` or a variable can bring in anything.
 */
export async function readStackAccess(
  deps: AppDeps,
  target: ServiceTarget,
  files: ComposeFiles,
  variables: Readonly<Record<string, string>>,
  redact: Redactor,
  signal?: AbortSignal,
): Promise<StackAccess> {
  const scope = { project: target.projectName, stack: composeProject(target) };
  const tree = await inspectStackFiles(files.projectDirectory, files.composeFile, {
    ...scope,
    dataDir: deps.config.dataDir,
  });
  const refuse = (refusal: Error): StackAccess => ({
    refusal,
    access: [],
    published: [],
    children: [],
    mounts: [],
    inputs: [],
    contexts: [],
    volumes: [],
    files: [],
    pulls: [],
    notes: [],
    fingerprint: "",
  });
  if (tree.refusal !== null) {
    return refuse(tree.refusal);
  }
  const blocking = tree.issues.find((issue) => issue.severity === "error");
  if (blocking !== undefined) {
    return refuse(fileRefusal(blocking, scope.stack));
  }

  const resolved = await resolveWithCompose(deps, target, files, variables, redact, signal);
  const foreign = foreignNetworks(resolved, scope);
  if (foreign[0] !== undefined) {
    return refuse(foreignNetworkRefusal(foreign[0].detail));
  }
  const {
    issues,
    insidePaths,
    mounts,
    inputs: buildInputs,
    files: envFiles,
  } = inspectResolved(resolved, {
    project: target.projectName,
    stack: scope.stack,
    dataDir: deps.config.dataDir,
    projectDirectory: files.projectDirectory,
    stackFiles: tree.files,
  });
  const refused = issues.find((issue) => issue.severity === "error");
  if (refused !== undefined) {
    return refuse(fileRefusal(refused, scope.stack));
  }
  const codeRoot = await realpath(composeCodeDir(deps, target));
  let contexts: ContextRead[];
  try {
    contexts = await readContexts(codeRoot, buildInputs);
  } catch (error) {
    return refuse(error instanceof Error ? error : new Error(String(error)));
  }
  const walked = writableInContext(contexts, mounts);
  if (walked !== null) {
    return refuse(writableInContextRefusal(walked));
  }
  // What the ignore files say is part of what was checked: nothing may change them now.
  const ignored = ignoreInputs(contexts);
  const projectRoot = await realpath(files.projectDirectory);
  const relative = (path: string) => fromStackFolder(projectRoot, path);
  const holdsIgnore = ownFolderIssues(
    mounts.flatMap((mount) => {
      const path = relative(mount.path);
      return path === null ? [] : [{ service: mount.service, path }];
    }),
    [],
    ignored.flatMap((input) => {
      const path = relative(input.path);
      return path === null ? [] : [{ ...input, path }];
    }),
  )[0];
  if (holdsIgnore !== undefined) {
    return refuse(fileRefusal(holdsIgnore, scope.stack));
  }
  const inputs = [...buildInputs, ...ignored];
  try {
    await assertMountsReal(deps, target, { mounts, inputs });
  } catch (error) {
    return refuse(error instanceof Error ? error : new Error(String(error)));
  }
  // The env files a variable named, which Compose reads as it starts the stack: no link on the way.
  const linkedEnv = await linkedMount(
    await realpath(files.projectDirectory),
    envFiles.map((path) => ({ service: null, path })),
  );
  if (linkedEnv !== null) {
    return refuse(linkedFileRefusal(linkedEnv));
  }
  let builds: BuildCheck;
  try {
    builds = await checkBuilds(resolved, {
      root: await realpath(composeCodeDir(deps, target)),
      projectDirectory: files.projectDirectory,
      project: target.projectName,
      stack: scope.stack,
    });
  } catch (error) {
    return refuse(error instanceof Error ? error : new Error(String(error)));
  }
  const access = [...tree.issues, ...issues, ...(await linksOut(insidePaths, files.projectDirectory))].filter(
    (issue) => issue.severity === "host",
  );
  const stackFiles = [...new Set([...tree.files, ...envFiles])];
  const digests = await digestFiles(files.projectDirectory, stackFiles);
  return {
    refusal: null,
    access,
    published: resolvedHostPorts(resolved),
    children: resolvedOverrideChildren(resolved, scope.stack),
    mounts,
    inputs,
    contexts,
    volumes: declaredVolumes(resolved, scope.stack),
    files: stackFiles,
    pulls: builds.pulls,
    notes: builds.notes,
    fingerprint: confirmationFingerprint(access, resolved, digests),
  };
}

/** Puts what nobody confirmed in front of an administrator, on the Source tab. */
function recordPendingAccess(
  deps: Pick<AppDeps, "db" | "now">,
  target: ServiceTarget,
  access: readonly ComposeIssue[],
): void {
  const record = requireService(deps, target);
  const compose = record.spec.compose;
  if (compose === null) {
    return;
  }
  const pending = [
    ...new Map(access.map((issue) => [`${issue.code}|${issue.service}|${issue.detail}`, issue])).values(),
  ];
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    { ...record.spec, compose: { ...compose, pendingAccess: pending } },
    new Date(deps.now()),
  );
}

/**
 * An administrator confirms everything the stack reaches on the server, what runs with that access
 * and the files the stack is read from, as they were when they did. A variable, an included file or a
 * new commit that changes any of it asks them again.
 */
function assertAccessConfirmed(
  deps: Pick<AppDeps, "db" | "now">,
  target: ServiceTarget,
  compose: StoredCompose,
  { access, fingerprint }: Pick<StackAccess, "access" | "fingerprint">,
): void {
  if (access.length === 0 || fingerprint === compose.acknowledgedAccess) {
    return;
  }
  recordPendingAccess(deps, target, access);
  const shown = accessFacts(access)
    .slice(0, 3)
    .map((fact) => fact.split("|").filter(Boolean).join(" "))
    .join("; ");
  throw conflict(
    "compose_needs_confirmation",
    `This stack reaches the server in ways nobody has confirmed (${shown}), or what runs with that access, or a file the stack is read from, changed since someone did. An administrator has to confirm it on the Source tab before it deploys.`,
  );
}

/** Pulls and builds, starts the containers, and only reports success once they have stayed up. */
export async function deployStack(
  deps: AppDeps,
  target: ServiceTarget,
  record: ServiceRecord,
  compose: StoredCompose,
  prepared: PreparedStack,
  ctx: ActionContext,
  options: StackDeployOptions,
): Promise<string[]> {
  const { files } = prepared;
  const variables = stackVariables(deps, target, record, ctx.log);
  const redact = serviceRedactor(deps, target);

  await applyEnvFile(files.projectDirectory, compose.envFile, variables);
  await writeStackOverride(deps, target, record, prepared.content);

  ctx.log("Checking the Compose file with Compose");
  const stack = await readStackAccess(deps, target, files, variables, redact, ctx.signal);
  if (stack.refusal !== null) {
    throw stack.refusal;
  }
  assertAccessConfirmed(deps, target, compose, stack);
  await assertStackPortsFree(deps, target, stack.published);
  // Before any pull or build, so that a stack that has to be stopped first is told so at once.
  await assertVolumesAsDeclared(deps, target, stack.volumes);
  await assertNothingRunningHolds(deps, target, stack);
  // Every child as Compose resolved it, so that an included one is marked and pulls like the rest.
  await writeOverride(deps, target, record, stack.children);
  for (const note of stack.notes) {
    ctx.log(note);
  }

  await prepareStackNetwork(deps, target, ctx);

  const shared = {
    files,
    variables,
    redact,
    signal: ctx.signal,
    timeoutMs: deps.config.buildTimeoutMs,
    onLine: (line: string) => {
      if (!PULL_PROGRESS.test(line)) {
        ctx.log(line);
      }
    },
  };
  await pullStackImages(deps, stack.pulls, ctx);
  if (options.force === true) {
    ctx.log("Building without the cache");
    assertComposeSucceeded(
      "Building",
      await runCompose(deps, target, ["build", "--no-cache", "--pull"], shared),
    );
  }
  ctx.phase("rollout");
  // Once more as late as possible: a build can take long, and Docker reads these paths as it starts.
  await assertNothingRunningHolds(deps, target, stack);
  await assertMountsReal(deps, target, stack);
  ctx.log("Starting the stack");
  assertComposeSucceeded(
    "Starting the stack",
    await runCompose(
      deps,
      target,
      [
        "up",
        "--detach",
        "--build",
        "--remove-orphans",
        ...(options.force === true ? ["--pull", "always", "--force-recreate"] : []),
      ],
      shared,
    ),
  );

  ctx.phase("verify");
  ctx.log("Waiting for the stack to settle");
  return watchStack(deps, target, ctx, redact);
}
