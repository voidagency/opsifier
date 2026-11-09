import { setTimeout as sleep } from "node:timers/promises";
import type { ExposeSettings } from "@opsifier/contract";
import { databaseActionTypes } from "@opsifier/contract";
import type { ActionContext } from "../../../core/actions";
import type { AppDeps } from "../../../core/context";
import type { TaskInfo } from "../../../core/docker";
import { conflict } from "../../../core/errors";
import { rolloutDatabase } from "../../databases/rollout";
import { publishedPort, requireDatabase } from "../../databases/service";
import { qualifiedName } from "../../services/compile";
import { firstPortInUse, PortInUseError } from "../../services/host-ports";
import { type DeployOptions, runDeploy } from "../../services/lifecycle";
import { listServiceRecords, saveServiceSpec } from "../../services/repo";
import { assertRuntimeCertain } from "../../services/runtime-state";
import type { ServiceTarget } from "../../services/service";

/** Ports the platform itself depends on, whichever way the server is set up. */
const RESERVED_PORTS: ReadonlyMap<number, string> = new Map([
  [2375, "Docker's API"],
  [2376, "Docker's API"],
  [2377, "Swarm's cluster management"],
  [4789, "Swarm's overlay networks"],
  [7946, "Swarm's node discovery"],
]);

function reservedPortOwner(deps: AppDeps, port: number): string | null {
  if (port === deps.config.port) {
    return "this panel";
  }
  return RESERVED_PORTS.get(port) ?? null;
}

const publishesTcp = (ports: readonly { protocol: "tcp" | "udp"; published: number }[], port: number) =>
  ports.some((entry) => entry.protocol === "tcp" && entry.published === port);

/** The name a conflict may give a holder: its own within this project, nothing that says more. */
const SOMEONE_ELSE = "another service";

/**
 * Who else already holds the port: saved services, including those that are stopped and will want
 * it back, anything Swarm runs, a plain container, or a process on the host.
 */
export async function findPortOwner(
  deps: AppDeps,
  target: ServiceTarget,
  port: number,
): Promise<string | null> {
  for (const record of listServiceRecords(deps.db)) {
    if (record.projectName === target.projectName && record.name === target.serviceName) {
      continue;
    }
    const held = record.spec.database?.exposedPort === port || publishesTcp(record.spec.ports, port);
    if (held) {
      return record.projectName === target.projectName
        ? `${record.projectName}/${record.name}`
        : SOMEONE_ELSE;
    }
  }

  const self = qualifiedName(target.projectName, target.serviceName);
  for (const service of await deps.docker.listServices()) {
    if (service.name === self) {
      continue;
    }
    const held = service.spec.EndpointSpec?.Ports?.some(
      (entry) => entry.PublishedPort === port && (entry.Protocol ?? "tcp") === "tcp",
    );
    if (held === true) {
      return service.name.startsWith(`${target.projectName}_`) ? service.name : SOMEONE_ELSE;
    }
  }
  return (await firstPortInUse(deps, target, [{ protocol: "tcp", port }])) === null ? null : SOMEONE_ELSE;
}

function savePort(deps: AppDeps, target: ServiceTarget, port: number): void {
  const record = requireDatabase(deps, target);
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    { ...record.spec, database: { ...record.spec.database, exposedPort: port } },
    new Date(deps.now()),
  );
}

/** The ways Docker reports that a host-mode port is taken: by Swarm, or when the task tries to bind. */
const PORT_IN_USE =
  /port.*(already in use|already allocated|is in use)|address already in use|bind:.*in use/i;

const reportsPortConflict = (task: TaskInfo): boolean =>
  PORT_IN_USE.test(task.error ?? "") || PORT_IN_USE.test(task.message);

/**
 * Watches the new tasks for a port conflict so the rollout does not sit in Pending until its
 * timeout, which can be minutes, while the database is down. Swarm also reports a conflict for a
 * moment while the previous task is still letting go of the port, so a report only counts once it
 * has lasted as long as a rollout's stability window.
 */
async function watchForPortConflict(
  deps: AppDeps,
  service: string,
  port: number,
  previousTaskIds: ReadonlySet<string>,
  signal: AbortSignal,
  onConflict: (error: PortInUseError) => void,
): Promise<void> {
  let firstSeen: number | null = null;
  while (!signal.aborted) {
    const tasks = await deps.docker.listTasks({ service }).catch(() => []);
    const conflicting = tasks.some((task) => !previousTaskIds.has(task.id) && reportsPortConflict(task));
    firstSeen = conflicting ? (firstSeen ?? performance.now()) : null;
    if (firstSeen !== null && performance.now() - firstSeen >= deps.rollout.stableMs) {
      onConflict(
        new PortInUseError(`Port ${port} is already in use on this server, so it was left as it was.`),
      );
      return;
    }
    await sleep(deps.rollout.pollMs, undefined, { signal }).catch(() => undefined);
  }
}

/** Rolls out and cuts the wait short the moment Docker reports the port as taken. */
async function rolloutWatchingPort(
  deps: AppDeps,
  target: ServiceTarget,
  port: number,
  ctx: ActionContext,
  rollOut: (watched: ActionContext) => Promise<void>,
): Promise<void> {
  const service = qualifiedName(target.projectName, target.serviceName);
  const previous = new Set((await deps.docker.listTasks({ service }).catch(() => [])).map((task) => task.id));
  const watcher = new AbortController();
  const rollout = new AbortController();
  const signal = AbortSignal.any([ctx.signal, rollout.signal]);

  let conflict: PortInUseError | null = null;
  const watching = watchForPortConflict(deps, service, port, previous, watcher.signal, (error) => {
    conflict = error;
    rollout.abort(error);
  });
  try {
    await rollOut({ ...ctx, signal });
  } catch (error) {
    throw conflict ?? error;
  } finally {
    watcher.abort();
    await watching;
  }
}

/** Validates a new public port and saves it. It reaches the server at the database's next deployment. */
export async function saveExpose(
  deps: AppDeps,
  target: ServiceTarget,
  settings: ExposeSettings,
  actorEmail: string | undefined,
): Promise<ExposeSettings> {
  const { port } = settings;
  const { exposedPort } = requireDatabase(deps, target).spec.database;
  if (port !== exposedPort) {
    assertRuntimeCertain(deps, target);
  }
  if (port !== 0) {
    const reserved = reservedPortOwner(deps, port);
    if (reserved !== null) {
      throw conflict("port_reserved", `Port ${port} is used by ${reserved}.`, {
        port: `Port ${port} is used by ${reserved}`,
      });
    }
    const owner = await findPortOwner(deps, target, port);
    if (owner !== null) {
      throw conflict("port_in_use", `Port ${port} is already used by ${owner}.`, {
        port: `Already used by ${owner}`,
      });
    }
  }

  savePort(deps, target, port);
  deps.actions.record({
    type: databaseActionTypes.expose,
    title:
      port === 0
        ? `Stop exposing ${target.projectName}/${target.serviceName}`
        : `Expose ${target.projectName}/${target.serviceName} on port ${port}`,
    ...target,
    actorEmail,
  });
  return { port };
}

/**
 * Deploys a database with the public port it has saved. A port that isn't published yet can turn
 * out to be taken on the host, which only the rollout can tell, and the database is down by then
 * because stop-first has already stopped the old task. So it goes back up on the port it had, and
 * the deployment fails saying why.
 */
export async function deployDatabaseWithPort(
  deps: AppDeps,
  target: ServiceTarget,
  ctx: ActionContext,
  options: DeployOptions,
): Promise<void> {
  const port = requireDatabase(deps, target).spec.database.exposedPort;
  const published = (await publishedPort(deps, target)) ?? port;
  if (port === published) {
    await runDeploy(deps, target, ctx, options);
    return;
  }
  ctx.log(port === 0 ? "Removing the public port" : `Publishing port ${port} on the host`);
  try {
    await rolloutWatchingPort(deps, target, port, ctx, (watched) =>
      runDeploy(deps, target, watched, options),
    );
  } catch (error) {
    if (!(error instanceof PortInUseError)) {
      throw error;
    }
    ctx.log(error.message);
    savePort(deps, target, published);
    await rolloutDatabase(deps, target, ctx);
    throw error;
  }
  ctx.log(port === 0 ? "The database is no longer exposed" : `Port ${port} is now open`);
}
