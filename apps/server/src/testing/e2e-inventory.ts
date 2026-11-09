/**
 * What a project still has on a Docker daemon, by name. End-to-end tests call this after cleaning up,
 * so that a cleanup that only looked like it worked is caught, on the disposable resources it made
 * itself and on nothing else.
 */
export function projectLeftovers(docker: (...args: string[]) => string, project: string): string[] {
  const list = (kind: string, ...args: string[]): string[] =>
    docker(...args)
      .split("\n")
      .filter((name) => name !== "")
      .map((name) => `${kind} ${name}`);

  const prefix = `${project}_`;
  const services = list("service", "service", "ls", "--format", "{{.Name}}");
  const containers = list("container", "ps", "--all", "--format", "{{.Names}}");
  const volumes = list("volume", "volume", "ls", "--format", "{{.Name}}");
  const networks = list("network", "network", "ls", "--format", "{{.Name}}");

  const named = (entries: string[], matches: (name: string) => boolean) =>
    entries.filter((entry) => matches(entry.slice(entry.indexOf(" ") + 1)));

  return [
    ...named(services, (name) => name.startsWith(prefix)),
    // A task of a Swarm service is named `<service>.<slot>.<id>`, so it starts the same way.
    ...named(containers, (name) => name.startsWith(prefix)),
    ...named(volumes, (name) => name.startsWith(prefix)),
    ...named(networks, (name) => name === `opsifier-${project}` || name === `opsifier-${project}_proxy`),
  ];
}
