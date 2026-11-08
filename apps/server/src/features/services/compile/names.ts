/** The Swarm service name, which is also the hostname other tasks reach it on. */
export const qualifiedName = (project: string, service: string): string => `${project}_${service}`;

/** The tag a service's own image is built under. It only exists on this server. */
export const builtImageName = (project: string, service: string): string =>
  `opsifier/${project}/${service}:latest`;

/** The attachable overlay network the services of one project share. */
export const projectNetworkName = (project: string): string => `opsifier-${project}`;
