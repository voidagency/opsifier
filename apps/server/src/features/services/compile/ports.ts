import type { PortSpec } from "@opsifier/contract";
import type { SwarmServiceSpec } from "../../../core/docker";

export function compilePorts(ports: readonly PortSpec[]): NonNullable<SwarmServiceSpec["EndpointSpec"]> {
  if (ports.length === 0) {
    return { Mode: "vip" };
  }
  return {
    Mode: "vip",
    Ports: ports.map((port) => ({
      Protocol: port.protocol,
      TargetPort: port.target,
      PublishedPort: port.published,
      PublishMode: "host",
    })),
  };
}
