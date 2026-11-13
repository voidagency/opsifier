import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ComposeDetail,
  type ComposeRuntime,
  type CreateComposeRequest,
  isRoutableComposeChild,
  type SaveComposeSourceRequest,
  type ServiceDetail,
  saveComposeSourceRequest,
} from "@opsifier/contract";
import { and, eq } from "drizzle-orm";
import type { AppDeps } from "../../core/context";
import { domains } from "../../core/db/schema";
import type { ComposeContainerInfo } from "../../core/docker";
import { AppError, conflict, notFound } from "../../core/errors";
import { ToolNotFoundError } from "../../core/tools";
import { assignDefaultDomain } from "../service-tabs/domains/service";
import { probeRemote } from "../service-tabs/source/build/git";
import { resolveInside } from "../service-tabs/source/build/paths";
import { gitRemoteOf } from "../service-tabs/source/build/pipeline";
import { sourceIdentity } from "../service-tabs/source/identity";
import {
  prepareSshAccess,
  probeRefusal,
  recordWithdrawal,
  withdrawAuthority,
  withKeyBinding,
} from "../service-tabs/source/service";
import { composeChildAddress } from "../services/compile";
import { serviceRedactor } from "../services/masking";
import { ownerLabels } from "../services/ownership";
import {
  findService,
  insertService,
  listServiceRecords,
  type ServiceRecord,
  saveServiceSpec,
} from "../services/repo";
import {
  assertAddressFree,
  assertNameFits,
  assertRoomForServices,
  getServiceDetail,
  requireProject,
  requireService,
  type ServiceTarget,
  serviceDir,
  writeProxyConfig,
} from "../services/service";
import { appServiceSpec } from "../services/spec";
import {
  hashCompose,
  readStackAccess,
  stackFilesOnDisk,
  stackVariables,
  writeInlineCompose,
  writeStackOverride,
} from "./deploy";
import { type ComposeInspection, hasHostAccess, inspectComposeFile } from "./inspect";
import { composeCodeDir, composeProject } from "./names";
import { accessFingerprint } from "./resolved";
import type { StoredCompose } from "./spec";
import { toComposeChildren } from "./status";

export const isComposeRecord = (record: Pick<ServiceRecord, "spec">): boolean => record.spec.compose !== null;

export function requireCompose(record: ServiceRecord): StoredCompose {
  if (record.spec.compose === null) {
    throw notFound("This service is not a Compose stack.");
  }
  return record.spec.compose;
}

const RESERVED_PORTS = [
  [80, "the proxy"],
  [443, "the proxy"],
  [3000, "the panel"],
] as const;

/** Every host port something else already holds, so a collision can be reported before it happens. */
export function takenPorts(deps: Pick<AppDeps, "db">, target: ServiceTarget): Map<number, string> {
  const taken = new Map<number, string>(RESERVED_PORTS);
  for (const record of listServiceRecords(deps.db)) {
    if (record.projectName === target.projectName && record.name === target.serviceName) {
      continue;
    }
    // A service of another project stays anonymous: a conflict must not say what that project holds.
    const owner = record.projectName === target.projectName ? `${record.projectName}/${record.name}` : "";
    for (const port of record.spec.ports) {
      taken.set(port.published, owner);
    }
    if (record.spec.database !== null && record.spec.database.exposedPort > 0) {
      taken.set(record.spec.database.exposedPort, owner);
    }
  }
  return taken;
}

export function inspectStackFile(
  deps: Pick<AppDeps, "config" | "db">,
  target: ServiceTarget,
  content: string,
): ComposeInspection {
  return inspectComposeFile(content, {
    dataDir: deps.config.dataDir,
    takenPorts: takenPorts(deps, target),
    project: target.projectName,
    stack: composeProject(target),
  });
}

/** The file as it stands: what was typed, or what the last checkout brought. */
export async function currentContent(
  deps: Pick<AppDeps, "config">,
  target: ServiceTarget,
  compose: StoredCompose,
): Promise<string | null> {
  const { source } = compose;
  if (source === null) {
    return null;
  }
  if (source.type === "inline") {
    return source.content;
  }
  try {
    const code = composeCodeDir(deps, target);
    const directory = await resolveInside(code, source.path.replace(/^\/+/, ""), "The build path");
    return await readFile(await resolveInside(directory, source.file, "The Compose file"), "utf8");
  } catch {
    // Not fetched yet, or no longer where it was: the next deploy finds out properly.
    return null;
  }
}

export async function getComposeDetail(deps: AppDeps, target: ServiceTarget): Promise<ComposeDetail> {
  const record = requireService(deps, target);
  const compose = requireCompose(record);
  const content = await currentContent(deps, target, compose);
  const inspection =
    content === null
      ? { services: [], issues: [], parseError: null }
      : inspectStackFile(deps, target, content);
  // What the last deploy found the stack reaching beyond the file on the page, waiting for a person.
  const shown = new Set(inspection.issues.map((issue) => `${issue.code}|${issue.service}|${issue.detail}`));
  const pending = compose.pendingAccess.filter(
    (issue) => !shown.has(`${issue.code}|${issue.service}|${issue.detail}`),
  );
  const acknowledged =
    content !== null &&
    compose.acknowledgedHash === hashCompose(content) &&
    compose.pendingAccess.length === 0;

  return {
    source: compose.source,
    content,
    issues: [...inspection.issues, ...pending],
    parseError: inspection.parseError,
    services: inspection.services,
    acknowledgementRequired: (hasHostAccess(inspection) || compose.pendingAccess.length > 0) && !acknowledged,
    acknowledged,
    envFile: compose.envFile,
    sshPublicKey: record.spec.build.sshKey?.publicKey ?? null,
  };
}

/** A file with a single service has only one place its default domain can point. */
function targetDomainsAt(
  deps: Pick<AppDeps, "db" | "now">,
  target: ServiceTarget,
  children: readonly string[],
): void {
  const routable = children.filter(isRoutableComposeChild);
  if (routable.length !== 1 || routable[0] === undefined) {
    return;
  }
  deps.db
    .update(domains)
    .set({ composeService: routable[0], updatedAt: new Date(deps.now()) })
    .where(
      and(
        eq(domains.projectName, target.projectName),
        eq(domains.serviceName, target.serviceName),
        eq(domains.composeService, ""),
      ),
    )
    .run();
}

function persistCompose(
  deps: Pick<AppDeps, "db" | "now">,
  target: ServiceTarget,
  update: (
    compose: StoredCompose,
    spec: ServiceRecord["spec"],
  ) => { compose: StoredCompose; build?: ServiceRecord["spec"]["build"] },
): ServiceRecord {
  const record = requireService(deps, target);
  const { compose, build } = update(requireCompose(record), record.spec);
  const spec = { ...record.spec, compose, ...(build === undefined ? {} : { build }) };
  saveServiceSpec(deps.db, target.projectName, target.serviceName, spec, new Date(deps.now()));
  return requireService(deps, target);
}

/** Saves the source. Nothing that is running changes until the next deploy. */
export async function saveComposeSource(
  deps: AppDeps,
  target: ServiceTarget,
  request: SaveComposeSourceRequest,
  actorEmail: string | undefined,
): Promise<ComposeDetail> {
  const record = requireService(deps, target);
  requireCompose(record);
  const source = saveComposeSourceRequest.parse(request);
  const before = sourceIdentity(record.spec);

  let sshKey = record.spec.build.sshKey;
  if (source.type === "git") {
    sshKey = prepareSshAccess(deps, source.url, record.spec.build).sshKey;
    await probeSource(deps, { ...record.spec.build, sshKey }, source);
  }

  let withdrawn = false;
  const updated = persistCompose(deps, target, (compose, spec) => {
    const settled = withdrawAuthority(
      withKeyBinding(spec.build, sshKey),
      before,
      sourceIdentity({ source: null, compose: { ...compose, source } }),
      false,
    );
    withdrawn = settled.withdrawn;
    // What a deploy found waiting was about the file before this one.
    return { compose: { ...compose, source, pendingAccess: [] }, build: settled.build };
  });
  if (source.type === "inline") {
    await mkdir(serviceDir(deps, target.projectName, target.serviceName), { recursive: true, mode: 0o700 });
    await writeInlineCompose(deps, target, source.content);
    targetDomainsAt(deps, target, inspectStackFile(deps, target, source.content).services);
  }
  await writeProxyConfig(deps, target, requireService(deps, target).spec);

  deps.actions.record({
    type: "service.source",
    title: `Update the Compose file of ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
  if (withdrawn) {
    recordWithdrawal(deps, target, actorEmail);
  }
  return getComposeDetail(deps, { projectName: updated.projectName, serviceName: updated.name });
}

async function probeSource(
  deps: AppDeps,
  build: ServiceRecord["spec"]["build"],
  source: Extract<ReturnType<typeof saveComposeSourceRequest.parse>, { type: "git" }>,
): Promise<void> {
  let result: Awaited<ReturnType<typeof probeRemote>>;
  try {
    result = await probeRemote(deps, gitRemoteOf(deps, source, build), source.ref);
  } catch (error) {
    if (error instanceof ToolNotFoundError) {
      throw new AppError(503, "git_unavailable", "git is not installed on this server.");
    }
    throw error;
  }
  if (!result.ok) {
    throw probeRefusal(result);
  }
}

/** What the stack reaches on the server right now, as Compose resolves it, in the form a confirmation keeps. */
async function resolvedAccessFingerprint(
  deps: AppDeps,
  target: ServiceTarget,
  record: ServiceRecord,
  compose: StoredCompose,
  content: string,
): Promise<string> {
  const files = await stackFilesOnDisk(deps, target, compose);
  await writeStackOverride(deps, target, record, content);
  try {
    const { access } = await readStackAccess(
      deps,
      target,
      files,
      stackVariables(deps, target, record, () => undefined),
      serviceRedactor(deps, target),
    );
    return accessFingerprint(access);
  } catch (error) {
    throw conflict(
      "compose_invalid",
      `Compose could not read this stack, so there is nothing to confirm yet: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Binds a confirmation given somewhere else, such as a template's form, to what the stack reaches now.
 * Left unbound when Compose can't read the stack yet: its first deploy then asks for a confirmation.
 */
export async function bindConfirmedAccess(deps: AppDeps, target: ServiceTarget): Promise<void> {
  const record = requireService(deps, target);
  const compose = requireCompose(record);
  const content = await currentContent(deps, target, compose);
  if (content === null || compose.acknowledgedHash !== hashCompose(content)) {
    return;
  }
  const access = await resolvedAccessFingerprint(deps, target, record, compose, content).catch(
    (error: unknown) => {
      deps.logger.warn({ err: error, target }, "Could not read what a confirmed stack reaches");
      return null;
    },
  );
  if (access !== null) {
    persistCompose(deps, target, (stored) => ({ compose: { ...stored, acknowledgedAccess: access } }));
  }
}

/**
 * Records that someone read this exact file and accepts what it can do to the server: the file, and
 * everything it reaches once Compose has resolved it with the stack's variables and the files it brings
 * in, as they are now. A change to any of that asks again.
 */
export async function acknowledgeCompose(
  deps: AppDeps,
  target: ServiceTarget,
  content: string,
  actorEmail: string | undefined,
): Promise<ComposeDetail> {
  const record = requireService(deps, target);
  const compose = requireCompose(record);
  const current = await currentContent(deps, target, compose);
  if (current === null || current !== content) {
    throw conflict("compose_changed", "This Compose file has changed. Read it again before confirming.");
  }
  const access = await resolvedAccessFingerprint(deps, target, record, compose, content);
  persistCompose(deps, target, (stored) => ({
    compose: {
      ...stored,
      acknowledgedHash: hashCompose(content),
      acknowledgedAccess: access,
      pendingAccess: [],
    },
  }));
  deps.actions.record({
    type: "service.source",
    title: `Confirm the host access of ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
  return getComposeDetail(deps, target);
}

export async function setComposeEnvFile(
  deps: AppDeps,
  target: ServiceTarget,
  enabled: boolean,
): Promise<ComposeDetail> {
  persistCompose(deps, target, (compose) => ({ compose: { ...compose, envFile: enabled } }));
  return getComposeDetail(deps, target);
}

/** What each child of the stack is doing right now. */
export async function getComposeRuntime(deps: AppDeps, target: ServiceTarget): Promise<ComposeRuntime> {
  const record = requireService(deps, target);
  const compose = requireCompose(record);
  const containers = await deps.docker.listComposeContainers(composeProject(target));
  const children = toComposeChildren(containers, {
    stopped: record.spec.stopped,
    completedChildren: compose.completedChildren,
  });
  const addresses = Object.fromEntries(
    children.map((child) => [child.name, composeChildAddress(composeProject(target), child.name)]),
  );
  return { children, addresses };
}

/** Containers of this Compose project that carry no sign of having been started by this panel. */
export async function unmarkedStackContainers(
  deps: Pick<AppDeps, "docker">,
  target: ServiceTarget,
): Promise<ComposeContainerInfo[]> {
  const labels = ownerLabels(target);
  const containers = await deps.docker.listComposeContainers(composeProject(target));
  return containers.filter((container) =>
    Object.entries(labels).some(([key, value]) => container.labels?.[key] !== value),
  );
}

/** Compose acts on whatever carries a project's name, so a new stack can't take one already in use. */
export async function assertComposeNameFree(
  deps: Pick<AppDeps, "docker" | "logger">,
  target: ServiceTarget,
): Promise<void> {
  const unmarked = await unmarkedStackContainers(deps, target).catch((error: unknown) => {
    deps.logger.warn({ err: error }, "Could not check whether Compose already uses this name");
    return [];
  });
  if (unmarked.length > 0) {
    throw conflict(
      "service_not_owned",
      "Containers of a Compose project with this name already run here, and this panel did not start them. Give this stack another name.",
      { name: "Docker already runs something under this name" },
    );
  }
}

/** Starts empty: nothing runs until a file is saved and deployed. */
export async function createCompose(
  deps: AppDeps,
  projectName: string,
  request: CreateComposeRequest,
  actorEmail: string | undefined,
): Promise<ServiceDetail> {
  const target = { projectName, serviceName: request.name };
  requireProject(deps, projectName);
  assertNameFits(projectName, request.name);
  assertRoomForServices(deps, projectName);
  if (findService(deps.db, projectName, request.name) !== undefined) {
    throw conflict("service_exists", "A service with this name already exists.", {
      name: "This name is taken in this project",
    });
  }
  assertAddressFree(deps, target);
  await assertComposeNameFree(deps, target);

  const now = new Date(deps.now());
  const spec = appServiceSpec.parse({ compose: {} });
  deps.db.transaction((tx) => {
    insertService(tx, projectName, request.name, "compose", spec, now);
    assignDefaultDomain(deps, tx, target, now, { composeService: "" });
  });

  await mkdir(join(serviceDir(deps, projectName, request.name), "code"), { recursive: true, mode: 0o755 });
  await writeProxyConfig(deps, target, spec);

  deps.actions.record({
    type: "service.create",
    title: `Create ${projectName}/${request.name}`,
    ...target,
    actorEmail,
  });
  return getServiceDetail(deps, target);
}
