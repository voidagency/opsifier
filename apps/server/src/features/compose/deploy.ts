import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parse } from "yaml";
import type { ActionContext } from "../../core/actions";
import type { AppDeps } from "../../core/context";
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
import type { ServiceRecord } from "../services/repo";
import { requireProject, type ServiceTarget, serviceDir } from "../services/service";
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
import { assertComposeSucceeded, type ComposeFiles, runCompose } from "./run";
import type { StoredCompose, StoredComposeGitSource } from "./spec";
import { containerState } from "./status";

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
function stackVariables(
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

function assertRunnable(prepared: PreparedStack): { services: Record<string, unknown> } {
  const parsed: unknown = parse(prepared.content, { merge: true });
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

/** Compose's own reading of the file, before anything is started. */
async function validateWithCompose(
  deps: AppDeps,
  target: ServiceTarget,
  files: ComposeFiles,
  variables: Readonly<Record<string, string>>,
  redact: Redactor,
  ctx: ActionContext,
): Promise<void> {
  ctx.log("Checking the Compose file with Compose");
  const result = await runCompose(deps, target, ["config", "--quiet"], {
    files,
    variables,
    redact,
    signal: ctx.signal,
    timeoutMs: 60_000,
    onLine: ctx.log,
  });
  assertComposeSucceeded("Checking the Compose file", result);
}

/**
 * A file can get a network from places the inspection doesn't read: an `include`, an `extends`, a
 * variable. So what Compose itself resolved is held to the same rule, right before anything starts.
 */
async function assertStaysInProject(
  deps: AppDeps,
  target: ServiceTarget,
  files: ComposeFiles,
  variables: Readonly<Record<string, string>>,
  redact: Redactor,
  ctx: ActionContext,
): Promise<void> {
  const output = `${files.overrideFile}.${randomBytes(6).toString("hex")}.resolved`;
  try {
    assertComposeSucceeded(
      "Reading the resolved Compose file",
      await runCompose(deps, target, ["config", "--format", "json", "--output", output], {
        files,
        variables,
        redact,
        signal: ctx.signal,
        timeoutMs: 60_000,
      }),
    );
    const resolved = JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>;
    const foreign = foreignNetworks(resolved, { project: target.projectName, stack: composeProject(target) });
    if (foreign[0] !== undefined) {
      throw foreignNetworkRefusal(foreign[0].detail);
    }
  } finally {
    await rm(output, { force: true });
  }
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
  await writeFileAtomic(
    files.overrideFile,
    renderComposeOverride({
      project: target.projectName,
      service: target.serviceName,
      id: record.id,
      qualified: composeProject(target),
      children: overrideChildren(assertRunnable(prepared)),
    }),
    0o600,
  );

  await prepareStackNetwork(deps, target, ctx);
  await validateWithCompose(deps, target, files, variables, redact, ctx);
  await assertStaysInProject(deps, target, files, variables, redact, ctx);

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
