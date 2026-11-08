import {
  type DeployOutcome,
  deployActionType,
  type ServiceStatus,
  type ServiceSummary,
} from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import type { ServiceInfo, TaskInfo, TaskState } from "../../core/docker";
import { qualifiedName } from "./compile";
import {
  type ActiveActionRow,
  listActiveServiceActions,
  listRecentDeployments,
  type ServiceRecord,
} from "./repo";

const WAKE_LENGTH = 24;
const RECENT_FAILURE_MS = 60_000;
const FAILED_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["failed", "rejected", "orphaned"]);

/** One reading of Docker, shared by every row of a response. Null when Docker did not answer. */
export type LiveState = {
  services: ReadonlyMap<string, ServiceInfo>;
  tasks: ReadonlyMap<string, TaskInfo[]>;
} | null;

export async function readLiveState(deps: Pick<AppDeps, "docker" | "logger">): Promise<LiveState> {
  try {
    const [services, tasks] = await Promise.all([deps.docker.listServices(), deps.docker.listTasks()]);
    const grouped = new Map<string, TaskInfo[]>();
    for (const task of tasks) {
      grouped.set(task.serviceName, [...(grouped.get(task.serviceName) ?? []), task]);
    }
    return { services: new Map(services.map((service) => [service.name, service])), tasks: grouped };
  } catch (error) {
    deps.logger.warn({ err: error }, "Could not read the state of the services");
    return null;
  }
}

function deriveStatus(
  live: LiveState,
  name: string,
  stopped: boolean,
  now: number,
): { status: ServiceStatus; replicas: ServiceSummary["replicas"] } {
  if (live === null) {
    return { status: "unknown", replicas: { running: 0, desired: 0 } };
  }
  const swarm = live.services.get(name);
  if (swarm === undefined) {
    return { status: stopped ? "stopped" : "undeployed", replicas: { running: 0, desired: 0 } };
  }

  const desired = swarm.spec.Mode?.Replicated?.Replicas ?? 0;
  const tasks = live.tasks.get(name) ?? [];
  const running = tasks.filter((task) => task.state === "running" && task.desiredState === "running").length;
  const replicas = { running, desired };

  if (desired === 0) {
    return { status: "stopped", replicas };
  }
  if (running >= desired) {
    return { status: "running", replicas };
  }
  const failedRecently = tasks.some(
    (task) => FAILED_STATES.has(task.state) && now - Date.parse(task.updatedAt) < RECENT_FAILURE_MS,
  );
  return { status: failedRecently ? "failing" : "starting", replicas };
}

const OUTCOMES: Record<string, DeployOutcome> = {
  queued: "running",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

export type ActionIndex = ReadonlyMap<string, ActiveActionRow>;

/** The first queued or running action of each service, keyed `project/service`. */
export function indexActiveActions(deps: Pick<AppDeps, "db">): ActionIndex {
  const index = new Map<string, ActiveActionRow>();
  for (const action of listActiveServiceActions(deps.db)) {
    const key = `${action.projectName}/${action.serviceName}`;
    if (!index.has(key)) {
      index.set(key, action);
    }
  }
  return index;
}

/** One row of the project page and of Overview. */
export function summarize(
  deps: Pick<AppDeps, "db" | "now">,
  record: ServiceRecord,
  live: LiveState,
  active: ActionIndex,
): ServiceSummary {
  const name = qualifiedName(record.projectName, record.name);
  const deployments = listRecentDeployments(deps.db, deployActionType, record, WAKE_LENGTH);
  const action = active.get(`${record.projectName}/${record.name}`);

  return {
    projectName: record.projectName,
    name: record.name,
    type: record.type,
    ...deriveStatus(live, name, record.spec.stopped, deps.now()),
    activeAction: action === undefined ? null : { id: action.id, type: action.type },
    wake: deployments.map((deployment) => OUTCOMES[deployment.status] ?? "cancelled").reverse(),
    lastDeployedAt: deployments[0]?.createdAt.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}
