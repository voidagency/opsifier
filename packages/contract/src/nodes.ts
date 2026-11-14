import { z } from "zod";

/**
 * The servers of the Docker Swarm the panel runs, as its managers see them. Read only for now: adding,
 * draining and removing a node come with the private network between servers.
 */
export const swarmNode = z.object({
  id: z.string(),
  hostname: z.string(),
  role: z.enum(["manager", "worker"]),
  /** The manager the others follow. */
  leader: z.boolean(),
  state: z.enum(["ready", "down", "disconnected", "unknown"]),
  /** `drain` moves every task off the node, `pause` lets none new start on it. */
  availability: z.enum(["active", "pause", "drain"]),
  /** The address the node is reached on. */
  address: z.string().nullable(),
  engineVersion: z.string().nullable(),
  os: z.string().nullable(),
  architecture: z.string().nullable(),
  /** Its processors, in cores. */
  cpus: z.number().nullable(),
  memoryBytes: z.number().int().nullable(),
  /** The node the panel itself runs on. */
  self: z.boolean(),
  /** How many containers of services run on it now. */
  runningTasks: z.number().int(),
});
export type SwarmNode = z.infer<typeof swarmNode>;

/** GET /api/v1/server/nodes. Managers first, the leader at the top. */
export const swarmNodeList = z.object({ nodes: z.array(swarmNode) });
export type SwarmNodeList = z.infer<typeof swarmNodeList>;
