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
import { requireHostAccess } from "../../access/guard";
import type { Access } from "../../access/rules";
import { isDatabaseRecord } from "../../databases/service";
import { firstPortInUse } from "../../services/host-ports";
import { saveServiceSpec } from "../../services/repo";
import { assertRuntimeCertain } from "../../services/runtime-state";
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
  access: Access,
): DeploySettings {
  const record = requireService(deps, target);
  // Some capabilities are a way out of the container, so granting a new one is the server's to decide.
  if (settings.capAdd.some((name) => !record.spec.deploy.capAdd.includes(name))) {
    requireHostAccess(access);
  }
  if (isDatabaseRecord(record) && settings.replicas !== 1) {
    // Saving a number that would then be ignored is how a topology that can't exist looks like it does.
    throw badRequest("unsupported_topology", "A database runs as exactly one task.", {
      replicas: "A database runs exactly one replica",
    });
  }
  if (record.spec.box !== null) {
    // It runs one task, stop-first, under its own supervisor: anything else breaks what a box promises.
    throw conflict(
      "box_deploy_managed",
      "A box runs one task at a time under its own supervisor. Its processes and hooks have their own tabs.",
    );
  }
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

/** Read here, in one step with the write, because the checks before it can wait on Docker. */
function savePorts(
  deps: AppDeps,
  target: ServiceTarget,
  change: (ports: PortSpec[]) => PortSpec[],
): PortSpec[] {
  const record = requireService(deps, target);
  const ports = change(record.spec.ports);
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

/** What Docker or the host is holding right now, which also covers what is not Opsifier's. */
async function isTakenOnHost(deps: AppDeps, target: ServiceTarget, port: PortSpec): Promise<boolean> {
  try {
    return (await firstPortInUse(deps, target, [{ protocol: port.protocol, port: port.published }])) !== null;
  } catch (error) {
    // A save never needs Docker. The deployment looks again before it replaces anything.
    deps.logger.warn({ err: error }, "Could not read the ports in use on this server");
    return false;
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
  if (savedPortsElsewhere(deps, target).some(same) || (await isTakenOnHost(deps, target, port))) {
    throw portTakenError("port_in_use", "This port is already in use on this server.");
  }
}

export async function addPort(deps: AppDeps, target: ServiceTarget, port: PortSpec): Promise<PortSpec[]> {
  const { ports, deploy } = requireService(deps, target).spec;
  if (ports.length >= MAX_PORTS) {
    throw badRequest("too_many_ports", "This service publishes as many ports as it can hold.");
  }
  if (deploy.replicas > 1) {
    throw badRequest("ports_with_replicas", "A published port can only be held by one task on a host.", {
      published: "Run one replica to publish a port",
    });
  }
  await assertFreeForService(deps, target, ports, port);
  return savePorts(deps, target, (current) => [...current, port]);
}

export async function updatePort(
  deps: AppDeps,
  target: ServiceTarget,
  index: number,
  port: PortSpec,
): Promise<PortSpec[]> {
  const { ports } = requireService(deps, target).spec;
  if (index >= ports.length) {
    throw notFound("This port does not exist.");
  }
  assertRuntimeCertain(deps, target);
  await assertFreeForService(deps, target, ports, port, index);
  return savePorts(deps, target, (current) =>
    current.map((existing, position) => (position === index ? port : existing)),
  );
}

export function removePort(deps: AppDeps, target: ServiceTarget, index: number): PortSpec[] {
  const { ports } = requireService(deps, target).spec;
  if (index >= ports.length) {
    throw notFound("This port does not exist.");
  }
  assertRuntimeCertain(deps, target);
  return savePorts(deps, target, (current) => current.filter((_, position) => position !== index));
}

export function removeAllPorts(deps: AppDeps, target: ServiceTarget): PortSpec[] {
  assertRuntimeCertain(deps, target);
  return savePorts(deps, target, () => []);
}
