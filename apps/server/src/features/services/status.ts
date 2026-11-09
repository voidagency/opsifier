import {
  type DeployOutcome,
  deploymentActionTypes,
  type ServiceStatus,
  type ServiceSummary,
} from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import type { ComposeContainerInfo, ServiceInfo, TaskInfo, TaskState } from "../../core/docker";
import { composeStatus } from "../compose/status";
import { qualifiedName } from "./compile";
import {
  type ActiveActionRow,
  listActiveServiceActions,
  listRecentDeployments,
  type ServiceRecord,
} from "./repo";
import { runtimeUncertainty } from "./runtime-state";

const WAKE_LENGTH = 24;
const RECENT_FAILURE_MS = 60_000;
const FAILED_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["failed", "rejected", "orphaned"]);

/** One reading of Docker, shared by every row of a response. Null when Docker did not answer. */
export type LiveState = {
  services: ReadonlyMap<string, ServiceInfo>;
  tasks: ReadonlyMap<string, TaskInfo[]>;
  /** Containers Docker Compose started, by Compose project. */
  stacks: ReadonlyMap<string, ComposeContainerInfo[]>;
} | null;

export async function readLiveState(deps: Pick<AppDeps, "docker" | "logger">): Promise<LiveState> {
  try {
    const [services, tasks, containers] = await Promise.all([
      deps.docker.listServices(),
      deps.docker.listTasks(),
      deps.docker.listComposeContainers(),
    ]);
    const grouped = new Map<string, TaskInfo[]>();
    for (const task of tasks) {
      grouped.set(task.serviceName, [...(grouped.get(task.serviceName) ?? []), task]);
    }
    const stacks = new Map<string, ComposeContainerInfo[]>();
    for (const container of containers) {
      stacks.set(container.project, [...(stacks.get(container.project) ?? []), container]);
    }
    return { services: new Map(services.map((service) => [service.name, service])), tasks: grouped, stacks };
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

/** A Compose stack's state comes from its containers, since it has no Swarm service. */
function deriveStackStatus(
  live: LiveState,
  name: string,
  record: ServiceRecord,
): { status: ServiceStatus; replicas: ServiceSummary["replicas"] } {
  if (live === null) {
    return { status: "unknown", replicas: { running: 0, desired: 0 } };
  }
  return composeStatus(live.stacks.get(name) ?? [], {
    stopped: record.spec.stopped,
    completedChildren: record.spec.compose?.completedChildren ?? [],
  });
}

const OUTCOMES: Record<string, DeployOutcome> = {
  queued: "running",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  uncertain: "uncertain",
};

export type ActionIndex = ReadonlyMap<string, ActiveActionRow>;

/** The first queued or running action of each service, keyed `project/service`. */
export function indexActiveActions(deps: Pick<AppDeps, "db" | "actions">): ActionIndex {
  const index = new Map<string, ActiveActionRow>();
  for (const action of listActiveServiceActions(deps.db)) {
    const key = `${action.projectName}/${action.serviceName}`;
    if (!index.has(key) && deps.actions.current(action).status !== "uncertain") {
      index.set(key, action);
    }
  }
  return index;
}

/** One row of the project page and of Overview. */
export function summarize(
  deps: Pick<AppDeps, "db" | "now" | "actions">,
  record: ServiceRecord,
  live: LiveState,
  active: ActionIndex,
): ServiceSummary {
  const name = qualifiedName(record.projectName, record.name);
  const deployments = listRecentDeployments(deps.db, deploymentActionTypes, record, WAKE_LENGTH);
  const action = active.get(`${record.projectName}/${record.name}`);

  return {
    projectName: record.projectName,
    name: record.name,
    type: record.type,
    ...(record.spec.compose === null
      ? deriveStatus(live, name, record.spec.stopped, deps.now())
      : deriveStackStatus(live, name, record)),
    activeAction: action === undefined ? null : { id: action.id, type: action.type },
    runtimeUncertain: runtimeUncertainty(deps, record),
    wake: deployments
      .map((deployment) => OUTCOMES[deps.actions.current(deployment).status] ?? "cancelled")
      .reverse(),
    lastDeployedAt: deployments[0]?.createdAt.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}
