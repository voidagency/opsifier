import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import { SHARED_NETWORK } from "../services/compile/database";

/**
 * The installer creates the shared network, but it may be gone or, in a sandbox, not exist at all.
 * A deploy is the moment to find out, rather than having Swarm reject the service with a network
 * error nobody can act on.
 */
export async function ensureSharedNetwork(
  deps: Pick<AppDeps, "docker">,
  log: (line: string) => void,
): Promise<void> {
  if ((await deps.docker.inspectNetwork(SHARED_NETWORK)) !== null) {
    return;
  }
  log(`Creating the ${SHARED_NETWORK} network`);
  try {
    await deps.docker.createNetwork({ name: SHARED_NETWORK, driver: "overlay", attachable: true });
  } catch (error) {
    // Two deploys can race to create it. Whichever loses just uses the winner's network.
    if (!(error instanceof DockerDriverError && error.statusCode === 409)) {
      throw error;
    }
  }
}
