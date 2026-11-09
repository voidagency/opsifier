import type { ServiceDetail } from "@opsifier/contract";
import { saveDomainRequest } from "@opsifier/contract";
import type { z } from "zod";
import type { AppDeps } from "../../core/context";
import { requireHostAccess } from "../access/guard";
import type { Access } from "../access/rules";
import { createDomain } from "../service-tabs/domains/changes";
import { saveServiceSource } from "../service-tabs/source/service";
import { addMount } from "../service-tabs/storage/service";
import { sealEnv } from "../services/env-store";
import { enqueueDeploy } from "../services/lifecycle";
import { deleteServiceRow, saveServiceSpec } from "../services/repo";
import { createService, getServiceDetail, requireService, type ServiceTarget } from "../services/service";

type Definition = z.output<typeof import("@opsifier/contract").serviceDefinitionRequest>;

/** Everything goes in before anything can run. If any part is refused, the service never existed. */
export async function createFromDefinition(
  deps: AppDeps,
  project: string,
  definition: Definition,
  access: Access,
  actorEmail: string | undefined,
  isAdmin: boolean,
): Promise<ServiceDetail> {
  const target: ServiceTarget = { projectName: project, serviceName: definition.name };
  // Before anything exists, so a refusal leaves nothing behind to clean up.
  if (definition.mounts.some((mount) => mount.type === "bind")) {
    requireHostAccess(access);
  }
  await createService(deps, project, { name: definition.name, type: "app" }, actorEmail);

  try {
    await saveServiceSource(deps, target, definition.source, { actorEmail, isAdmin });

    const record = requireService(deps, target);
    if (definition.env !== "" || definition.resources !== undefined) {
      saveServiceSpec(
        deps.db,
        project,
        definition.name,
        {
          ...record.spec,
          sealedEnv: sealEnv(deps, definition.env),
          ...(definition.resources === undefined ? {} : { resources: definition.resources }),
        },
        new Date(deps.now()),
      );
    }

    for (const mount of definition.mounts) {
      addMount(deps, target, mount, access);
    }
    for (const domain of definition.domains) {
      await createDomain(deps, target, saveDomainRequest.parse(domain));
    }
  } catch (error) {
    deleteServiceRow(deps.db, project, definition.name);
    await deps.proxy.removeService(project, definition.name).catch(() => undefined);
    throw error;
  }

  if (definition.deploy) {
    enqueueDeploy(deps, target, actorEmail);
  }
  return getServiceDetail(deps, target);
}
