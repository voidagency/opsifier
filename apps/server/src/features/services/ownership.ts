import type { AppDeps } from "../../core/context";
import type { ServiceInfo, VolumeInfo } from "../../core/docker";
import { conflict } from "../../core/errors";
import { qualifiedName } from "./compile";
import type { ServiceTarget } from "./service";

/** The labels the panel puts on everything it makes for a service. They are how it knows it did. */
export const ownerLabels = (target: ServiceTarget): Record<string, string> => ({
  "opsifier.project": target.projectName,
  "opsifier.service": target.serviceName,
});

function carriesOwnerLabels(labels: Readonly<Record<string, string>> | undefined, target: ServiceTarget) {
  return Object.entries(ownerLabels(target)).every(([key, value]) => labels?.[key] === value);
}

export const isOwnedSwarmService = (swarm: ServiceInfo, target: ServiceTarget): boolean =>
  carriesOwnerLabels(swarm.spec.Labels, target);

export const isOwnedVolume = (volume: VolumeInfo, target: ServiceTarget): boolean =>
  carriesOwnerLabels(volume.labels, target);

function foreignServiceError(name: string) {
  return conflict(
    "service_not_owned",
    `Docker already runs a service named ${name} that this panel did not create, so it was left alone. Remove it, or give this service another name.`,
    { name: "Docker already runs something under this name" },
  );
}

/** The Swarm service of this row, or null when there is none. Refuses one the panel did not make. */
export async function inspectOwnedService(
  deps: Pick<AppDeps, "docker">,
  target: ServiceTarget,
): Promise<ServiceInfo | null> {
  const name = qualifiedName(target.projectName, target.serviceName);
  const swarm = await deps.docker.inspectService(name);
  if (swarm !== null && !isOwnedSwarmService(swarm, target)) {
    throw foreignServiceError(name);
  }
  return swarm;
}

/**
 * A new name has to be free in what is applied as well as what is saved. Docker being away is no
 * reason to refuse a name: nothing is touched until a deploy, and that looks again.
 */
export async function assertNameFreeInDocker(
  deps: Pick<AppDeps, "docker" | "logger">,
  target: ServiceTarget,
): Promise<void> {
  let swarm: ServiceInfo | null;
  try {
    swarm = await deps.docker.inspectService(qualifiedName(target.projectName, target.serviceName));
  } catch (error) {
    deps.logger.warn({ err: error }, "Could not check whether Docker already uses this name");
    return;
  }
  if (swarm !== null && !isOwnedSwarmService(swarm, target)) {
    throw foreignServiceError(swarm.name);
  }
}

/** What Docker runs under this name is only the panel's to remove if the panel made it. */
export async function removeOwnedService(
  deps: Pick<AppDeps, "docker">,
  target: ServiceTarget,
  log: (line: string) => void,
): Promise<void> {
  const name = qualifiedName(target.projectName, target.serviceName);
  const swarm = await deps.docker.inspectService(name);
  if (swarm !== null && !isOwnedSwarmService(swarm, target)) {
    log(`Leaving the Swarm service ${name} alone: this panel did not create it`);
    return;
  }
  log(`Removing the Swarm service ${name}`);
  await deps.docker.removeService(name);
}
