/** The Swarm service name, which is also the hostname other tasks reach it on. */
export const qualifiedName = (project: string, service: string): string => `${project}_${service}`;

/**
 * The name the proxy and the rest of a project reach one child of a Compose stack on. Service names
 * can't hold two underscores in a row, so this can never be the address of a service.
 */
export const composeChildAddress = (qualified: string, child: string): string => `${qualified}__${child}`;

/** The tag a service's own image is built under. It only exists on this server. */
export const builtImageName = (project: string, service: string): string =>
  `opsifier/${project}/${service}:latest`;

/** What a deployment keeps the outgoing image under, until it is sure it won't need it again. */
export const heldImageName = (project: string, service: string): string =>
  `opsifier/${project}/${service}:previous`;

/**
 * The tag that keeps one version of a service on this server. It holds the service's identifier and
 * not its name, because a version outlives a rename and nothing else moves this tag.
 */
export const releaseImageName = (serviceId: string, number: number): string =>
  `opsifier/releases/${serviceId}:${number}`;

/** A service's stable identifier, as a label on whatever Docker holds for it. */
export const idLabel = (id: string | null | undefined): Record<string, string> =>
  typeof id === "string" ? { "opsifier.id": id } : {};

/** Where the panel and the proxy meet. No workload ever joins it. */
export const SHARED_NETWORK = "opsifier";

/** The attachable overlay network the services of one project share. */
export const projectNetworkName = (project: string): string => `opsifier-${project}`;

/**
 * The network the proxy reaches one project's workloads on, apart from the one they talk to each
 * other over. Project names hold no underscore, so this can never be another project's network.
 */
export const projectProxyNetworkName = (project: string): string => `${projectNetworkName(project)}_proxy`;

/** What a workload the proxy may route to joins, and the names it answers to among its project. */
export const routedNetworks = (project: string, aliases: string[]) => [
  { Target: projectNetworkName(project), Aliases: aliases },
  { Target: projectProxyNetworkName(project) },
];

/** Where an App lives on the network: what any deployment of it joins, whatever came before. */
export const appNetworks = (project: string, service: string) =>
  routedNetworks(project, [`${project}-${service}`, service]);

/** The project a network of ours belongs to, going by its name. Null when it isn't one of those. */
export function projectOfNetwork(name: string): string | null {
  if (!name.startsWith("opsifier-")) {
    return null;
  }
  const rest = name.slice("opsifier-".length);
  return rest.endsWith("_proxy") ? rest.slice(0, -"_proxy".length) : rest;
}
