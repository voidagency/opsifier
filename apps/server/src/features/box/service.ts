import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  BOX_MATRIX_REVISION,
  BOX_RUN_AS,
  BOX_WORKSPACE_PATH,
  BOX_WORKSPACE_VOLUME,
  type BoxDetail,
  type BoxHooks,
  type BoxModulesConfig,
  type BoxPresetId,
  type BoxProcess,
  boxModuleIssues,
  boxPreset,
  type CreateBoxRequest,
  type ServiceDetail,
} from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { badRequest, conflict, notFound } from "../../core/errors";
import { seedWorkspaceFiles } from "../box-ide/confined";
import { assignDefaultDomain } from "../service-tabs/domains/service";
import { assertNameFreeInDocker } from "../services/ownership";
import { findService, insertService, type ServiceRecord, saveServiceSpec } from "../services/repo";
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
import { type AppServiceSpec, appServiceSpec } from "../services/spec";
import { renderBoxDockerfile } from "./dockerfile";
import { boxChanges, boxManifestOf } from "./manifest";
import { type StoredBox, storedBox } from "./spec";

export type BoxRecord = ServiceRecord & { spec: AppServiceSpec & { box: StoredBox } };

export const isBoxRecord = (record: ServiceRecord): record is BoxRecord => record.spec.box !== null;

export function requireBox(deps: Pick<AppDeps, "db">, target: ServiceTarget): BoxRecord {
  const record = requireService(deps, target);
  if (!isBoxRecord(record)) {
    throw notFound("This service is not a box.");
  }
  return record;
}

/** Where the workspace lives on this server. The container sees it as {@link BOX_WORKSPACE_PATH}. */
export const boxWorkspaceDir = (deps: Pick<AppDeps, "config">, target: ServiceTarget): string =>
  join(serviceDir(deps, target.projectName, target.serviceName), "volumes", BOX_WORKSPACE_VOLUME);

/** Exists from the start, so the IDE and a preset's starter files have somewhere to work before a deploy. */
async function ensureWorkspace(deps: Pick<AppDeps, "config">, target: ServiceTarget): Promise<string> {
  const directory = boxWorkspaceDir(deps, target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o777);
  return directory;
}

/** Only what the settings generate is ever built: a Dockerfile written by hand would be overwritten. */
function withDockerfile(
  record: ServiceRecord,
  box: StoredBox,
): Pick<AppServiceSpec, "source"> & { box: StoredBox } {
  // A selection the matrix no longer offers keeps its last Dockerfile, and a deployment says why it stopped.
  return boxModuleIssues(box.modules).length > 0
    ? { source: record.spec.source, box }
    : { source: { type: "dockerfile", dockerfile: renderBoxDockerfile(box) }, box };
}

/** Saves settings and the Dockerfile they generate, reading the row in the same tick as the write. */
export function saveBox(
  deps: AppDeps,
  target: ServiceTarget,
  change: (box: StoredBox) => StoredBox,
): StoredBox {
  const record = requireBox(deps, target);
  const box = change(record.spec.box);
  saveServiceSpec(
    deps.db,
    target.projectName,
    target.serviceName,
    { ...record.spec, ...withDockerfile(record, box) },
    new Date(deps.now()),
  );
  return box;
}

const invalidModules = (issues: ReadonlyArray<{ field: string; message: string }>) =>
  badRequest(
    "box_modules_invalid",
    "Some fields need attention.",
    Object.fromEntries(issues.map(({ field, message }) => [field, message])),
  );

export function assertModulesSupported(modules: BoxModulesConfig): void {
  const issues = boxModuleIssues(modules);
  if (issues.length > 0) {
    throw invalidModules(issues);
  }
}

export function getBoxDetail(deps: AppDeps, target: ServiceTarget): BoxDetail {
  const record = requireBox(deps, target);
  const { box, source } = record.spec;
  return {
    modules: box.modules,
    processes: box.processes,
    hooks: box.hooks,
    preset: box.preset,
    matrixRevision: BOX_MATRIX_REVISION,
    built: box.built,
    pendingChanges: boxChanges(box.built, boxManifestOf(box)),
    issues: boxModuleIssues(box.modules),
    history: box.history,
    runtime: {
      ...BOX_RUN_AS,
      workspacePath: BOX_WORKSPACE_PATH,
      workspaceVolume: BOX_WORKSPACE_VOLUME,
    },
    dockerfile: source?.type === "dockerfile" ? source.dockerfile : "",
  };
}

function initialBox(presetId: BoxPresetId | null): { box: StoredBox; starterFiles: Record<string, string> } {
  if (presetId === null) {
    return { box: storedBox.parse({}), starterFiles: {} };
  }
  const preset = boxPreset(presetId);
  return {
    box: storedBox.parse({
      modules: preset.modules,
      processes: preset.processes,
      hooks: preset.hooks,
      preset: preset.id,
    }),
    starterFiles: { ...preset.starterFiles },
  };
}

export async function createBox(
  deps: AppDeps,
  projectName: string,
  request: CreateBoxRequest,
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
  await assertNameFreeInDocker(deps, target);

  const { box, starterFiles } = initialBox(request.preset ?? null);
  const now = new Date(deps.now());
  const spec = appServiceSpec.parse({
    box,
    source: { type: "dockerfile", dockerfile: renderBoxDockerfile(box) },
    mounts: [{ type: "volume", name: BOX_WORKSPACE_VOLUME, mountPath: BOX_WORKSPACE_PATH }],
    // One task at a time: two running at once would both be writing to the same workspace.
    deploy: { replicas: 1, zeroDowntime: false, tiniInit: true },
  });
  deps.db.transaction((tx) => {
    insertService(tx, projectName, request.name, "box", spec, now);
    assignDefaultDomain(deps, tx, target, now);
  });

  await mkdir(serviceDir(deps, projectName, request.name), { recursive: true, mode: 0o700 });
  await seedWorkspaceFiles(await ensureWorkspace(deps, target), starterFiles);
  await writeProxyConfig(deps, target, spec);

  deps.actions.record({
    type: "service.create",
    title: `Create ${projectName}/${request.name}`,
    ...target,
    actorEmail,
  });
  return getServiceDetail(deps, target);
}

export function saveBoxModules(deps: AppDeps, target: ServiceTarget, modules: BoxModulesConfig): BoxDetail {
  assertModulesSupported(modules);
  saveBox(deps, target, (box) => ({ ...box, modules }));
  return getBoxDetail(deps, target);
}

export function saveBoxProcesses(deps: AppDeps, target: ServiceTarget, processes: BoxProcess[]): BoxDetail {
  saveBox(deps, target, (box) => ({ ...box, processes }));
  return getBoxDetail(deps, target);
}

export function saveBoxHooks(deps: AppDeps, target: ServiceTarget, hooks: BoxHooks): BoxDetail {
  saveBox(deps, target, (box) => ({ ...box, hooks }));
  return getBoxDetail(deps, target);
}

/**
 * Replaces what a box is set to contain, and nothing it already holds: the workspace is only ever added
 * to, where no file of the same name exists. Like any setting, it reaches the box at the next deploy.
 */
export async function applyBoxPreset(
  deps: AppDeps,
  target: ServiceTarget,
  presetId: BoxPresetId,
  actorEmail: string | undefined,
): Promise<BoxDetail> {
  requireBox(deps, target);
  const preset = boxPreset(presetId);
  const directory = await ensureWorkspace(deps, target);
  const added = await seedWorkspaceFiles(directory, preset.starterFiles);
  saveBox(deps, target, (box) => ({
    ...box,
    modules: preset.modules,
    processes: preset.processes,
    hooks: preset.hooks,
    preset: preset.id,
  }));
  deps.actions.record({
    type: "box.preset",
    title: `Apply the ${preset.id} preset to ${target.projectName}/${target.serviceName}${added > 0 ? `, adding ${added} starter file${added === 1 ? "" : "s"}` : ""}`,
    ...target,
    actorEmail,
  });
  return getBoxDetail(deps, target);
}

/** Runs at boot, so that a panel upgraded to a newer matrix says at once which boxes it affects. */
export function refreshBoxDockerfiles(deps: AppDeps, records: readonly ServiceRecord[]): void {
  for (const record of records) {
    if (!isBoxRecord(record)) {
      continue;
    }
    const generated = withDockerfile(record, record.spec.box);
    const unchanged =
      record.spec.source?.type === "dockerfile" &&
      generated.source?.type === "dockerfile" &&
      record.spec.source.dockerfile === generated.source.dockerfile;
    if (!unchanged) {
      saveServiceSpec(
        deps.db,
        record.projectName,
        record.name,
        { ...record.spec, ...generated },
        new Date(deps.now()),
      );
    }
  }
}
