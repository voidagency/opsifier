import { projectNetworkName } from "../names";

/** The network every panel-managed database shares with the panel itself. */
export const SHARED_NETWORK = "opsifier";

export function compileDatabaseNetworks(
  project: string,
  service: string,
): Array<{ Target: string; Aliases: string[] }> {
  const alias = `${project}-${service}`;
  return [
    { Target: SHARED_NETWORK, Aliases: [alias] },
    { Target: projectNetworkName(project), Aliases: [alias, service] },
  ];
}
