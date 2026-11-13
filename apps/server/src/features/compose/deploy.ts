import { createHash, randomBytes } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
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
import { serviceRedactor } from "../services/masking";
import { type ServiceRecord, saveServiceSpec } from "../services/repo";
import { requireProject, requireService, type ServiceTarget, serviceDir } from "../services/service";
import { resolveReferences } from "../templates/references";
import { foreignNetworks } from "./inspect";
import {
  COMPOSE_INLINE_FILE,
  composeCodeDir,
  composeManifestFile,
  composeOverrideFile,
  composeProject,
} from "./names";
import { overrideChildren, renderComposeOverride } from "./override";
import { accessFacts, accessFingerprint, inspectResolved, type LocalPath } from "./resolved";
import { assertComposeSucceeded, type ComposeFiles, runCompose } from "./run";
import type { StoredCompose, StoredComposeGitSource } from "./spec";
import { containerState } from "./status";
import { inspectStackFiles } from "./tree";

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

/** Every file in a tree, as paths from its root. `verifyTree` has already refused anything strange. */
async function listFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else {
      files.push(relative(root, path));
    }
  }
  return files;
}

/**
 * Lays a fresh checkout over the stack's folder. Files the previous checkout brought and this one
 * does not are removed, but anything else is the stack's own, written through a relative mount, and
 * stays: a redeploy must not lose what a running stack produced.
 */
async function syncCheckout(staged: string, code: string, manifest: string): Promise<void> {
  const previous = await readManifest(manifest);
  const incoming = await listFiles(staged);
  const keep = new Set(incoming);
  await mkdir(code, { recursive: true, mode: 0o755 });
  for (const file of previous) {
    if (!keep.has(file)) {
      await rm(join(code, file), { force: true });
    }
  }
  await cp(staged, code, { recursive: true, force: true, verbatimSymlinks: true });
  await writeFileAtomic(manifest, JSON.stringify(incoming), 0o600);
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
    await syncCheckout(tree, code, composeManifestFile(deps, target));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  const relativePath = source.path.replace(/^\/+/, "");
  const projectDirectory = await resolveInside(code, relativePath, "The build path");
  const composeFile = await resolveInside(projectDirectory, source.file, "The Compose file");
  return {
    content: await readFile(composeFile, "utf8"),
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
async function applyEnvFile(
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
  const previous = await readFile(path, "utf8").catch(() => null);
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

/** Marks every child as the panel's and puts it on the project's networks. Written before Compose reads the stack. */
export async function writeStackOverride(
  deps: Pick<AppDeps, "config">,
  target: ServiceTarget,
  record: ServiceRecord,
  content: string,
): Promise<void> {
  await writeFileAtomic(
    composeOverrideFile(deps, target),
    renderComposeOverride({
      project: target.projectName,
      service: target.serviceName,
      id: record.id,
      qualified: composeProject(target),
      children: overrideChildren(assertRunnable(content)),
    }),
    0o600,
  );
}

/** What a stack reaches on the server, and what stops it outright, read through Compose with nothing started. */
export interface StackAccess {
  /** What no confirmation allows: another project's network, a program Compose would run, a file outside the stack. */
  refusal: Error | null;
  /** Every way the stack reaches the server, as Compose resolved it. */
  access: ComposeIssue[];
}

function fileRefusal(issue: ComposeIssue): Error {
  if (issue.code === "foreign_network") {
    return foreignNetworkRefusal(issue.detail ?? "another network");
  }
  return conflict(
    "compose_invalid",
    `This Compose file can't run: ${issue.code}${issue.detail === null ? "" : ` (${issue.detail})`}. See the Source tab.`,
  );
}

const isInside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`);

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
  const blocking = tree.find((issue) => issue.severity === "error");
  if (blocking !== undefined) {
    return { refusal: fileRefusal(blocking), access: [] };
  }

  const resolved = await resolveWithCompose(deps, target, files, variables, redact, signal);
  const foreign = foreignNetworks(resolved, scope);
  if (foreign[0] !== undefined) {
    return { refusal: foreignNetworkRefusal(foreign[0].detail), access: [] };
  }
  const { issues, insidePaths } = inspectResolved(resolved, {
    project: target.projectName,
    stack: scope.stack,
    dataDir: deps.config.dataDir,
    projectDirectory: files.projectDirectory,
  });
  const refused = issues.find((issue) => issue.severity === "error");
  if (refused !== undefined) {
    return { refusal: fileRefusal(refused), access: [] };
  }
  const access = [...tree, ...issues, ...(await linksOut(insidePaths, files.projectDirectory))].filter(
    (issue) => issue.severity === "host",
  );
  return { refusal: null, access };
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
 * An administrator confirms everything the stack reaches on the server, as it was when they did. A
 * variable, an included file or a new commit that changes any of it asks them again.
 */
function assertAccessConfirmed(
  deps: Pick<AppDeps, "db" | "now">,
  target: ServiceTarget,
  compose: StoredCompose,
  access: readonly ComposeIssue[],
): void {
  if (access.length === 0 || accessFingerprint(access) === compose.acknowledgedAccess) {
    return;
  }
  recordPendingAccess(deps, target, access);
  const shown = accessFacts(access)
    .slice(0, 3)
    .map((fact) => fact.split("|").filter(Boolean).join(" "))
    .join("; ");
  throw conflict(
    "compose_needs_confirmation",
    `This stack reaches the server in ways nobody has confirmed (${shown}). An administrator has to confirm them on the Source tab before it deploys.`,
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
  const { refusal, access } = await readStackAccess(deps, target, files, variables, redact, ctx.signal);
  if (refusal !== null) {
    throw refusal;
  }
  assertAccessConfirmed(deps, target, compose, access);

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
  if (options.force === true) {
    ctx.log("Building without the cache");
    assertComposeSucceeded(
      "Building",
      await runCompose(deps, target, ["build", "--no-cache", "--pull"], shared),
    );
  }
  ctx.phase("rollout");
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
