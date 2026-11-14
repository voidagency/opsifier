import type { SwarmNodeList } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";

/** The swarm's nodes, with what runs on each: managers first, the leader at the top. */
export async function listSwarmNodes(deps: Pick<AppDeps, "docker">): Promise<SwarmNodeList> {
  const [swarm, nodes, tasks] = await Promise.all([
    deps.docker.swarmInfo(),
    deps.docker.listNodes(),
    deps.docker.listTasks(),
  ]);
  const running = new Map<string, number>();
  for (const task of tasks) {
    if (task.state === "running" && task.nodeId !== null) {
      running.set(task.nodeId, (running.get(task.nodeId) ?? 0) + 1);
    }
  }
  const rank = (node: (typeof nodes)[number]) => (node.leader ? 0 : node.role === "manager" ? 1 : 2);
  return {
    nodes: nodes
      .map((node) => ({ ...node, self: node.id === swarm.nodeId, runningTasks: running.get(node.id) ?? 0 }))
      .sort((a, b) => rank(a) - rank(b) || a.hostname.localeCompare(b.hostname)),
  };
}
