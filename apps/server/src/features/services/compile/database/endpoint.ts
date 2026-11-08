import { type DatabaseEngine, databaseEngineInfo } from "@opsifier/contract";
import type { SwarmServiceSpec } from "../../../../core/docker";

/**
 * Databases answer on DNS alone: `dnsrr` hands out the task's address directly, which Swarm requires
 * for a task that publishes a port in host mode.
 */
export function compileDatabaseEndpoint(
  engine: DatabaseEngine,
  exposedPort: number,
): NonNullable<SwarmServiceSpec["EndpointSpec"]> {
  if (exposedPort === 0) {
    return { Mode: "dnsrr" };
  }
  return {
    Mode: "dnsrr",
    Ports: [
      {
        Protocol: "tcp",
        TargetPort: databaseEngineInfo[engine].port,
        PublishedPort: exposedPort,
        PublishMode: "host",
      },
    ],
  };
}
