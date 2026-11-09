import type { Config } from "../config";
import { DockerodeDriver } from "./dockerode";
import type { DockerDriver } from "./driver";
import { FakeDriver } from "./fake";

export { DockerodeDriver } from "./dockerode";
export * from "./driver";
export { FakeDriver, type FakeDriverOptions, type FakeExec } from "./fake";
export * from "./rollout";
export * from "./support";

/** `config.driver` has already refused `fake` in production: nothing here falls back. */
export function createDockerDriver(
  config: Pick<Config, "driver" | "dockerSocket" | "dockerHost">,
): DockerDriver {
  return config.driver === "fake"
    ? new FakeDriver()
    : new DockerodeDriver({ socketPath: config.dockerSocket, host: config.dockerHost });
}
