import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type DockerDriver, DockerDriverError, type NetworkInfo, type ServiceInfo } from "../core/docker";
import type { Created, SetupRecord } from "./ledger";
import { dataDirEntries, LOCK_FILE, readRecord, SETUP_RUN_LABEL, STATE_FILE } from "./ledger";
import { acquireLock, SetupError, type SetupTiming, waitForGone } from "./setup";

/** An address that this run registered, and the way to give it back. */
export interface RegisteredAddress {
  domain: string;
  release(log: (line: string) => void): Promise<void>;
}

export interface CleanSetupDeps {
  docker: DockerDriver;
  dataDir: string;
  log(line: string): void;
  /** Whether anyone has claimed the panel. Throws when that can't be told, which stops everything. */
  hasAccounts(): boolean;
  /** An address registered no earlier than `since`, which is when the run began. */
  addressRegisteredSince?(since: string): RegisteredAddress | null;
  timing?: Partial<SetupTiming>;
}

export interface CleanSetupResult {
  /** What was removed, or with no confirmation, what would be. */
  removed: string[];
  /** What is staying, and why. */
  kept: string[];
  confirmed: boolean;
}

const POLL_MS = 1000;
const REMOVAL_MS = 2 * 60_000;
const IMAGE_WAIT_MS = 20_000;
const LOCK_STALE_MS = 2 * 60_000;

interface Step {
  what: string;
  run(): Promise<void>;
}

interface Plan {
  steps: Step[];
  kept: string[];
}

const ownsService = (service: ServiceInfo, entry: Extract<Created, { kind: "service" }>, runId: string) =>
  service.spec.Labels?.[SETUP_RUN_LABEL] === runId && (entry.id === null || entry.id === service.id);

const ownsNetwork = (network: NetworkInfo, entry: Extract<Created, { kind: "network" }>, runId: string) =>
  network.labels[SETUP_RUN_LABEL] === runId && (entry.id === null || entry.id === network.id);

/** A task only lets go of a network, and its container of an image, a moment after its service has gone. */
async function retryWhileBusy(
  deps: CleanSetupDeps,
  waitMs: number,
  attempt: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await attempt();
      return;
    } catch (error) {
      if (!(error instanceof DockerDriverError) || Date.now() >= deadline) {
        throw error;
      }
      await sleep(deps.timing?.pollMs ?? POLL_MS);
    }
  }
}

/** An image is cache: whatever Docker says is using it is a reason to leave it, not a failure. */
async function removeImageOnceUnused(deps: CleanSetupDeps, ref: string): Promise<void> {
  await retryWhileBusy(deps, Math.min(deps.timing?.startupMs ?? IMAGE_WAIT_MS, IMAGE_WAIT_MS), () =>
    deps.docker.removeImage(ref),
  ).catch((error: unknown) => {
    deps.log(`Left ${ref} in place: ${error instanceof Error ? error.message : "it is in use"}`);
  });
}

/**
 * Why a Swarm this run started has to stay, or null if leaving it loses nothing. `gone` is what this
 * cleanup has already removed or is about to, which is the only thing that doesn't count. Leaving a
 * Swarm takes everything in it, and anything else in it is someone else's, however it got there.
 */
async function reasonToKeepSwarm(
  deps: CleanSetupDeps,
  entry: Extract<Created, { kind: "swarm" }>,
  gone: { services: ReadonlySet<string>; networks: ReadonlySet<string> },
): Promise<string | null> {
  const swarm = await deps.docker.swarmInfo();
  if (entry.nodeId !== null && swarm.nodeId !== entry.nodeId) {
    return "this node has joined another Swarm since";
  }
  if (!swarm.isManager) {
    return "this node doesn't manage it";
  }
  const services = (await deps.docker.listServices()).filter((service) => !gone.services.has(service.name));
  if (services.length > 0) {
    return `other services run on it (${services.map((service) => service.name).join(", ")})`;
  }
  const networks = (await deps.docker.listNetworks()).filter(
    (network) => network.scope === "swarm" && network.name !== "ingress" && !gone.networks.has(network.name),
  );
  if (networks.length > 0) {
    return `other networks are on it (${networks.map((network) => network.name).join(", ")})`;
  }
  const contents = await deps.docker.swarmContents();
  if (contents.nodes > 1) {
    return `${contents.nodes - 1} other node(s) have joined it`;
  }
  if (contents.secrets + contents.configs > 0) {
    return "it holds secrets or configs";
  }
  return null;
}

/** Works out what goes and what stays, from what Docker says now against what the run wrote down. */
async function planCleanup(deps: CleanSetupDeps, record: SetupRecord): Promise<Plan> {
  const steps: Step[] = [];
  const kept: string[] = [];
  const created = [...record.created].reverse();
  const services = new Set<string>();
  const networks = new Set<string>();
  let takenOver = false;

  for (const entry of created) {
    if (entry.kind === "service") {
      const service = await deps.docker.inspectService(entry.name);
      if (service !== null && ownsService(service, entry, record.runId)) {
        services.add(entry.name);
        steps.push({
          what: `the service "${entry.name}"`,
          run: async () => {
            await deps.docker.removeService(entry.name);
            await waitForGone(entry.name, deps);
          },
        });
      } else if (service !== null) {
        takenOver = true;
        kept.push(`the service "${entry.name}": it is not the one this setup made`);
      }
    }
  }

  for (const entry of created) {
    if (entry.kind === "network") {
      const network = await deps.docker.inspectNetwork(entry.name);
      if (network !== null && ownsNetwork(network, entry, record.runId)) {
        networks.add(entry.name);
        steps.push({
          what: `the network "${entry.name}"`,
          run: () =>
            retryWhileBusy(deps, deps.timing?.startupMs ?? REMOVAL_MS, () =>
              deps.docker.removeNetwork(entry.name),
            ),
        });
      } else if (network !== null) {
        takenOver = true;
        kept.push(`the network "${entry.name}": it is not the one this setup made`);
      }
    }
  }

  for (const entry of created) {
    if (entry.kind === "swarm" && (await deps.docker.swarmInfo()).state === "active") {
      const reason = await reasonToKeepSwarm(deps, entry, { services, networks });
      if (reason !== null) {
        kept.push(`the Swarm this setup started: ${reason}`);
      } else {
        steps.push({
          what: "the Swarm this setup started",
          run: async () => {
            // Asked again now, in case something has moved in meanwhile. What was just removed can
            // still be listed for a moment, so it goes on not counting.
            const now = await reasonToKeepSwarm(deps, entry, { services, networks });
            if (now !== null) {
              deps.log(`Keeping the Swarm: ${now}`);
              return;
            }
            await deps.docker.swarmLeave({ force: true });
          },
        });
      }
    }
  }

  for (const entry of created) {
    if (entry.kind === "image" && (await deps.docker.inspectImage(entry.ref)) !== null) {
      steps.push({ what: `the image ${entry.ref}`, run: () => removeImageOnceUnused(deps, entry.ref) });
    }
  }

  if (record.created.some((entry) => entry.kind === "address")) {
    const address = deps.addressRegisteredSince?.(record.startedAt) ?? null;
    if (address !== null) {
      steps.push({ what: `the address ${address.domain}`, run: () => address.release(deps.log) });
    }
  }

  const before = new Set(record.dataDirBefore);
  const fileNames = () => dataDirEntries(deps.dataDir).filter((name) => !before.has(name));
  if (takenOver) {
    if (fileNames().length > 0) {
      kept.push(`the files in ${deps.dataDir}: what this setup started has been replaced since`);
    }
  } else if (fileNames().length > 0) {
    steps.push({
      what: `${fileNames().join(", ")} in ${deps.dataDir}`,
      run: async () => {
        // Listed once more, because the panel this setup started kept writing until it was stopped.
        for (const name of fileNames()) {
          rmSync(join(deps.dataDir, name), { recursive: true, force: true });
        }
      },
    });
  }
  if (record.dataDirBefore.length > 0) {
    kept.push(`${record.dataDirBefore.join(", ")} in ${deps.dataDir}: already there before this setup`);
  }
  return { steps, kept };
}

function requireInterruptedRecord(deps: CleanSetupDeps): SetupRecord {
  const record = readRecord(deps.dataDir);
  if (record === null) {
    throw new SetupError("There is no record of a setup on this server, so there is nothing to remove.");
  }
  if (record.phase === "complete") {
    throw new SetupError(
      "The last setup on this server finished, so it left nothing half done. This command only removes what an interrupted one made.",
    );
  }
  if (record.runId === undefined || record.created === undefined || record.dataDirBefore === undefined) {
    throw new SetupError(
      "This setup stopped before its steps were being recorded, so nothing can be attributed to it. Run setup again to finish it. Nothing has been changed.",
    );
  }
  return record as SetupRecord;
}

/**
 * Removes what an interrupted setup made, and nothing that was there before it or has been changed
 * since. It can stop and be run again: the record stays until everything in it has gone. Without
 * `confirmed` it only reports what it would do, which is the record's own account of itself.
 */
export async function runCleanSetup(
  deps: CleanSetupDeps,
  options: { confirmed: boolean },
): Promise<CleanSetupResult> {
  if (!existsSync(deps.dataDir)) {
    throw new SetupError("There is no record of a setup on this server, so there is nothing to remove.");
  }
  const release = acquireLock(join(deps.dataDir, LOCK_FILE), deps.timing?.lockStaleMs ?? LOCK_STALE_MS);
  try {
    const record = requireInterruptedRecord(deps);
    let claimed: boolean;
    try {
      claimed = deps.hasAccounts();
    } catch (error) {
      throw new SetupError(
        `Could not tell whether this panel is in use, so nothing has been changed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (claimed) {
      throw new SetupError(
        "This panel already has an account, so it is in use. Run setup again to finish it. Nothing has been changed.",
      );
    }

    try {
      await deps.docker.ping();
    } catch (error) {
      throw new SetupError(
        `Docker does not answer, so nothing could be checked. Nothing has been changed. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    deps.log(`This setup stopped during the "${record.phase}" step, at ${record.at}.`);
    const plan = await planCleanup(deps, record);
    const removed = plan.steps.map((step) => step.what);
    if (removed.length === 0) {
      deps.log("It left nothing behind that this command can remove.");
    } else if (!options.confirmed) {
      deps.log("This would remove what it made:");
      removed.forEach((what) => {
        deps.log(`  ${what}`);
      });
    }
    if (plan.kept.length > 0) {
      deps.log("This stays:");
      plan.kept.forEach((what) => {
        deps.log(`  ${what}`);
      });
    }
    if (!options.confirmed) {
      if (removed.length > 0) {
        deps.log("Run clean-setup --yes to remove it.");
      }
      return { removed, kept: plan.kept, confirmed: false };
    }

    for (const step of plan.steps) {
      deps.log(`Removing ${step.what}`);
      await step.run();
    }
    rmSync(join(deps.dataDir, STATE_FILE), { force: true });
    deps.log(removed.length === 0 ? "Forgot that setup." : "Removed everything that setup made.");
    return { removed, kept: plan.kept, confirmed: true };
  } finally {
    release();
  }
}
