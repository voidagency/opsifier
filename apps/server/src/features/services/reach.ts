import { join } from "node:path";
import type { AppDeps } from "../../core/context";
import type { SwarmServiceSpec, TaskAccess } from "../../core/docker";
import { qualifiedName } from "./compile/names";
import type { ServiceRecord } from "./repo";

interface ServiceRef {
  projectName: string;
  serviceName: string;
}

/**
 * Whether a service reaches the server through something only an administrator can give it: a path on
 * the host, an added capability, or a Compose file whose access to the host someone confirmed. Whatever
 * runs in it reaches the server too, so what that is stays an administrator's to decide.
 */
export function reachesServer(record: Pick<ServiceRecord, "spec">): boolean {
  const { compose, mounts, deploy } = record.spec;
  if (compose !== null) {
    return compose.acknowledgedHash !== null || compose.acknowledgedAccess !== null;
  }
  return mounts.some((mount) => mount.type === "bind") || deploy.capAdd.length > 0;
}

/** The service's own files, which the panel binds into it itself, one by one. */
export const ownFilesDir = (deps: Pick<AppDeps, "config">, target: ServiceRef): string =>
  join(deps.config.dataDir, "projects", target.projectName, target.serviceName, "files");

/**
 * Whether a running task reaches the server, judged on what its container was given when it was made,
 * which outlives a mount or a capability taken out of the service's settings until the next deploy:
 * a host path other than the service's own files, or an added capability.
 */
export function taskReachesServer(access: TaskAccess, ownFiles: string): boolean {
  return access.capabilityAdd.length > 0 || access.binds.some((source) => !source.startsWith(`${ownFiles}/`));
}

/**
 * Whether the service's tasks reach the server, those that run or are being started and those it will
 * start until its next deploy: a mount or a capability taken out of the settings stays in its Swarm
 * spec, which a stopped service is started from again, and with every task made from that spec.
 */
export async function anyTaskReachesServer(
  deps: Pick<AppDeps, "docker" | "config">,
  target: ServiceRef,
): Promise<boolean> {
  const ownFiles = ownFilesDir(deps, target);
  const swarm = await deps.docker.inspectService(qualifiedName(target.projectName, target.serviceName));
  if (swarm !== null && taskReachesServer(specAccess(swarm.spec), ownFiles)) {
    return true;
  }
  const tasks = await deps.docker.listTasks({
    service: qualifiedName(target.projectName, target.serviceName),
  });
  for (const task of tasks) {
    if (task.state !== "running" && task.desiredState !== "running") {
      continue;
    }
    const access = await deps.docker.taskAccess(task.id);
    if (access !== null && taskReachesServer(access, ownFiles)) {
      return true;
    }
  }
  return false;
}

/** What a task made from this spec would be given, read as `taskAccess` reads it from a running one. */
export function specAccess(spec: SwarmServiceSpec): TaskAccess {
  const container = spec.TaskTemplate.ContainerSpec;
  return {
    binds: (container.Mounts ?? []).flatMap((mount) =>
      mount.Type === "bind" && mount.Source !== undefined ? [mount.Source] : [],
    ),
    capabilityAdd: [...((container.CapabilityAdd as string[] | undefined) ?? [])],
  };
}
