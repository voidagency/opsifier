import {
  type AdvancedDocument,
  type DeploySettings,
  MAX_PORTS,
  type PortSpec,
  portSpec,
} from "@opsifier/contract";
import { z } from "zod";
import type { AppDeps } from "../../../core/context";
import { services } from "../../../core/db/schema";
import { badRequest, conflict, notFound } from "../../../core/errors";
import { qualifiedName } from "../../services/compile";
import { type ServiceRecord, saveServiceSpec } from "../../services/repo";
import { requireService, type ServiceTarget } from "../../services/service";

/** The proxy holds these on every server. */
const PROXY_PORTS: readonly number[] = [80, 443];

const anyServiceSpec = z.object({ ports: z.array(portSpec).catch([]) }).catch({ ports: [] });

export function getAdvanced(deps: AppDeps, target: ServiceTarget): AdvancedDocument {
  const { deploy, ports, stopped } = requireService(deps, target).spec;
  return { deploy, ports, stopped };
}

const replicasError = () =>
  badRequest("validation_failed", "Some fields need attention.", { replicas: "Run at least one replica" });

export function saveDeploySettings(
  deps: AppDeps,
  target: ServiceTarget,
  settings: DeploySettings,
): DeploySettings {
  const record = requireService(deps, target);
  if (settings.replicas < 1 && !record.spec.stopped) {
    throw replicasError();
  }
  if (settings.replicas > 1 && record.spec.ports.length > 0) {
    throw badRequest("replicas_with_ports", "A published port can only be held by one task on a host.", {
      replicas: "Remove the published ports to run more than one replica",
    });
  }
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    { ...record.spec, deploy: settings },
    new Date(deps.now()),
  );
  return settings;
}

function savePorts(
  deps: AppDeps,
  target: ServiceTarget,
  record: ServiceRecord,
  ports: PortSpec[],
): PortSpec[] {
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    { ...record.spec, ports },
    new Date(deps.now()),
  );
  return ports;
}

const portTakenError = (code: string, message: string) => conflict(code, message, { published: message });

function assertNotReserved(deps: AppDeps, port: PortSpec): void {
  if (
    port.protocol === "tcp" &&
    (PROXY_PORTS.includes(port.published) || port.published === deps.config.port)
  ) {
    throw portTakenError("port_reserved", "This port is used by the panel or its proxy.");
  }
}

/** Every port another service wants, deployed or not. The two protocols are tracked apart. */
function savedPortsElsewhere(deps: AppDeps, target: ServiceTarget): PortSpec[] {
  return deps.db
    .select({ projectName: services.projectName, name: services.name, spec: services.spec })
    .from(services)
    .all()
    .filter((row) => row.projectName !== target.projectName || row.name !== target.serviceName)
    .flatMap((row) => anyServiceSpec.parse(row.spec).ports);
}

/** What Docker is publishing right now, which also covers services that are not Opsifier's. */
async function publishedInDocker(deps: AppDeps, target: ServiceTarget): Promise<PortSpec[]> {
  const self = qualifiedName(target.projectName, target.serviceName);
  try {
    const running = await deps.docker.listServices();
    return running
      .filter((service) => service.name !== self)
      .flatMap((service) => service.spec.EndpointSpec?.Ports ?? [])
      .flatMap((port) =>
        port.PublishedPort === undefined
          ? []
          : [
              {
                protocol: port.Protocol === "udp" ? ("udp" as const) : ("tcp" as const),
                published: port.PublishedPort,
                target: port.TargetPort,
              },
            ],
      );
  } catch (error) {
    // A save never needs Docker. The rollout will report a clash if Docker comes back with one.
    deps.logger.warn({ err: error }, "Could not read the ports Docker is publishing");
    return [];
  }
}

async function assertFreeForService(
  deps: AppDeps,
  target: ServiceTarget,
  ports: readonly PortSpec[],
  port: PortSpec,
  except?: number,
): Promise<void> {
  const same = (other: PortSpec) => other.protocol === port.protocol && other.published === port.published;
  if (ports.some((other, index) => index !== except && same(other))) {
    throw portTakenError("port_duplicate", "This service already publishes this port.");
  }
  assertNotReserved(deps, port);
  if (savedPortsElsewhere(deps, target).some(same) || (await publishedInDocker(deps, target)).some(same)) {
    throw portTakenError("port_in_use", "Another service already publishes this port.");
  }
}

export async function addPort(deps: AppDeps, target: ServiceTarget, port: PortSpec): Promise<PortSpec[]> {
  const record = requireService(deps, target);
  const { ports, deploy } = record.spec;
  if (ports.length >= MAX_PORTS) {
    throw badRequest("too_many_ports", "This service publishes as many ports as it can hold.");
  }
  if (deploy.replicas > 1) {
    throw badRequest("ports_with_replicas", "A published port can only be held by one task on a host.", {
      published: "Run one replica to publish a port",
    });
  }
  await assertFreeForService(deps, target, ports, port);
  return savePorts(deps, target, record, [...ports, port]);
}

export async function updatePort(
  deps: AppDeps,
  target: ServiceTarget,
  index: number,
  port: PortSpec,
): Promise<PortSpec[]> {
  const record = requireService(deps, target);
  const { ports } = record.spec;
  if (index >= ports.length) {
    throw notFound("This port does not exist.");
  }
  await assertFreeForService(deps, target, ports, port, index);
  return savePorts(
    deps,
    target,
    record,
    ports.map((existing, position) => (position === index ? port : existing)),
  );
}

export function removePort(deps: AppDeps, target: ServiceTarget, index: number): PortSpec[] {
  const record = requireService(deps, target);
  const { ports } = record.spec;
  if (index >= ports.length) {
    throw notFound("This port does not exist.");
  }
  return savePorts(
    deps,
    target,
    record,
    ports.filter((_, position) => position !== index),
  );
}

export function removeAllPorts(deps: AppDeps, target: ServiceTarget): PortSpec[] {
  return savePorts(deps, target, requireService(deps, target), []);
}
