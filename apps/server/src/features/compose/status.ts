import type { ComposeChild, ComposeChildState, ComposeContainer, ServiceStatus } from "@opsifier/contract";
import type { ComposeContainerInfo } from "../../core/docker";

/** Worst first: the state a child with several replicas, or a whole stack, is reported in. */
const STATE_ORDER: readonly ComposeChildState[] = [
  "failed",
  "unhealthy",
  "stopped",
  "starting",
  "running",
  "completed",
];

export function worstState(states: Iterable<ComposeChildState>): ComposeChildState | null {
  const seen = new Set(states);
  return STATE_ORDER.find((state) => seen.has(state)) ?? null;
}

export interface StackFacts {
  /** Stopped on purpose, so nothing being down is a problem. */
  stopped: boolean;
  /** Children that finished cleanly during their deploy. */
  completedChildren: readonly string[];
}

/** One container's state. A crash-looping one is failed even in the moment it happens to be up. */
export function containerState(container: ComposeContainerInfo, facts: StackFacts): ComposeChildState {
  switch (container.state) {
    case "running":
      if (container.health === "unhealthy") {
        return "unhealthy";
      }
      return container.health === "starting" ? "starting" : "running";
    case "created":
      return "starting";
    case "restarting":
      return container.exitCode === 0 ? "starting" : "failed";
    default:
      if (container.exitCode === 0 && facts.completedChildren.includes(container.child)) {
        return "completed";
      }
      if (facts.stopped) {
        return "stopped";
      }
      return container.exitCode === 0 || container.exitCode === 137 || container.exitCode === 143
        ? "stopped"
        : "failed";
  }
}

function toComposeContainer(container: ComposeContainerInfo, facts: StackFacts): ComposeContainer {
  return {
    id: container.id,
    name: container.name,
    image: container.image,
    state: containerState(container, facts),
    status: container.status,
    exitCode: container.exitCode,
    ports: container.ports,
  };
}

/** Children as the stack's page shows them: problems first, then by name. */
export function toComposeChildren(
  containers: readonly ComposeContainerInfo[],
  facts: StackFacts,
): ComposeChild[] {
  const byChild = new Map<string, ComposeContainerInfo[]>();
  for (const container of containers) {
    byChild.set(container.child, [...(byChild.get(container.child) ?? []), container]);
  }
  const children = [...byChild.entries()].map(([name, group]) => {
    const members = group.sort((a, b) => a.number - b.number).map((item) => toComposeContainer(item, facts));
    return {
      name,
      containers: members,
      state: worstState(members.map((member) => member.state)) ?? "stopped",
    };
  });
  return children.sort(
    (a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.name.localeCompare(b.name),
  );
}

/**
 * The state of a stack as a whole. Anything not `running` that is not meant to be, a stopped child
 * included, shows here: the stack is only running when all of it is.
 */
export function composeStatus(
  containers: readonly ComposeContainerInfo[],
  facts: StackFacts,
): { status: ServiceStatus; replicas: { running: number; desired: number } } {
  const states = containers.map((container) => containerState(container, facts));
  const expected = states.filter((state) => state !== "completed");
  const running = expected.filter((state) => state === "running" || state === "unhealthy").length;
  const replicas = { running, desired: facts.stopped ? 0 : expected.length };

  if (containers.length === 0) {
    return { status: facts.stopped ? "stopped" : "undeployed", replicas: { running: 0, desired: 0 } };
  }
  if (facts.stopped) {
    return { status: "stopped", replicas };
  }
  if (expected.some((state) => state === "failed" || state === "unhealthy" || state === "stopped")) {
    return { status: "failing", replicas };
  }
  if (expected.some((state) => state === "starting")) {
    return { status: "starting", replicas };
  }
  return { status: "running", replicas };
}
