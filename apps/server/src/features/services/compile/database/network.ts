import { projectNetworkName } from "../names";

/** A database answers on its project's network and nowhere else: only that project can reach it. */
export function compileDatabaseNetworks(
  project: string,
  service: string,
): Array<{ Target: string; Aliases: string[] }> {
  return [{ Target: projectNetworkName(project), Aliases: [`${project}-${service}`, service] }];
}
