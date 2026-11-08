import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { deployActionType, type RenameServiceRequest } from "@opsifier/contract";
import type { ActionContext, ActionRow } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import {
  type PullProgress,
  type RegistryAuth,
  type ServiceInfo,
  type SwarmServiceSpec,
  waitForRollout,
  waitForShutdown,
} from "../../core/docker";
import { conflict } from "../../core/errors";
import { removeDatabaseLeftovers } from "../databases/leftovers";
import { ensureSharedNetwork } from "../databases/network";
import { compileDatabaseRecord, isDatabaseRecord } from "../databases/service";
import { deleteRepositoryHook } from "../github/hooks";
import { ensureProjectNetwork, joinProxyToNetwork } from "../projects/network";
import { listDomainRows, toCompileDomains } from "../service-tabs/domains/service";
import { buildServiceImage } from "../service-tabs/source/build/pipeline";
import type { StoredSource } from "../service-tabs/source/stored";
import { prepareMounts, removeServiceVolumes } from "../service-tabs/storage/service";
import { compileService, qualifiedName } from "./compile";
import { deleteServiceRow, findService, type ServiceRecord, saveServiceSpec } from "./repo";
import {
  performRename,
  requireProject,
  requireService,
  type ServiceTarget,
  serviceDir,
  validateRename,
  writeProxyConfig,
} from "./service";
import { type AppServiceSpec, REGISTRY_PASSWORD_CONTEXT } from "./spec";

/** The base Docker Hub expects credentials to name, for images with no registry in their reference. */
const DOCKER_HUB = "https://index.docker.io/v1/";

/** Downloads repeat for every chunk. Only the steps worth reading afterwards are kept in the log. */
const NOISY_PULL_STATUSES =
  /^(Downloading|Extracting|Waiting|Verifying Checksum|Pulling fs layer|Download complete)/;

function registryServer(image: string): string {
  const [first = "", ...rest] = image.split("/");
  const isHost = rest.length > 0 && (first.includes(".") || first.includes(":") || first === "localhost");
  return isHost ? first : DOCKER_HUB;
}

function registryAuthFor(deps: AppDeps, source: StoredSource): RegistryAuth | undefined {
  if (source.type !== "image" || source.username === null || source.sealedPassword === null) {
    return undefined;
  }
  return {
    username: source.username,
    password: deps.secrets.unseal(source.sealedPassword, REGISTRY_PASSWORD_CONTEXT),
    serveraddress: registryServer(source.image),
  };
}

function logPullProgress(ctx: ActionContext): (progress: PullProgress) => void {
  const seen = new Set<string>();
  return ({ status, id }) => {
    if (NOISY_PULL_STATUSES.test(status)) {
      return;
    }
    const line = id === undefined ? status : `${id}: ${status}`;
    if (!seen.has(line)) {
      seen.add(line);
      ctx.log(line);
    }
  };
}

function withReplicas(spec: SwarmServiceSpec, replicas: number): SwarmServiceSpec {
  return { ...spec, Mode: { Replicated: { Replicas: replicas } } };
}

function currentReplicas(spec: SwarmServiceSpec): number {
  return spec.Mode?.Replicated?.Replicas ?? 0;
}

/** The tasks that exist now. A rollout is finished when different tasks have replaced them. */
async function currentTaskIds(deps: AppDeps, name: string, exists: boolean): Promise<Set<string>> {
  if (!exists) {
    return new Set();
  }
  return new Set((await deps.docker.listTasks({ service: name })).map((task) => task.id));
}

function setStopped(
  deps: AppDeps,
  target: ServiceTarget,
  record: ServiceRecord,
  stopped: boolean,
): AppServiceSpec {
  const spec = { ...record.spec, stopped };
  saveServiceSpec(deps.db, target.projectName, target.serviceName, spec, new Date(deps.now()));
  return spec;
}

export interface DeployOptions {
  /** Skip every build cache. Image sources have none, so it changes nothing for them. */
  force?: boolean;
}

interface DeploymentPlan {
  compiled: ReturnType<typeof compileService>;
  swarmSpec: SwarmServiceSpec;
  source: StoredSource;
}

function planDeployment(
  deps: AppDeps,
  target: ServiceTarget,
  record: ServiceRecord,
  forceUpdate: number,
  gitSha: string | null = null,
): DeploymentPlan {
  const { source } = record.spec;
  if (source === null) {
    throw new Error("This service has no source to deploy.");
  }
  const project = requireProject(deps, target.projectName);
  const compiled = isDatabaseRecord(record)
    ? compileDatabaseRecord(deps, target, record, forceUpdate, { stopped: false })
    : compileService({
        project,
        service: { name: target.serviceName, spec: { ...record.spec, stopped: false } },
        domains: toCompileDomains(listDomainRows(deps.db, target)),
        dataDir: deps.config.dataDir,
        forceUpdate,
        gitSha,
      });
  if (compiled.swarmSpec === null) {
    throw new Error("This service has no source to deploy.");
  }
  return { compiled, swarmSpec: compiled.swarmSpec, source };
}

export async function writeMountFiles(files: DeploymentPlan["compiled"]["files"]): Promise<void> {
  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
    await writeFile(file.path, file.content, { mode: file.mode ?? 0o600 });
    await chmod(file.path, file.mode ?? 0o600);
  }
}

async function prepareNetwork(deps: AppDeps, target: ServiceTarget, ctx: ActionContext): Promise<void> {
  ctx.log(`Preparing the network of ${target.projectName}`);
  if (isDatabaseRecord(requireService(deps, target))) {
    await ensureSharedNetwork(deps, ctx.log);
  }
  const network = await ensureProjectNetwork(deps.docker, target.projectName);
  await joinProxyToNetwork(deps.docker, network, ctx.log);
}

/** Pull or build, roll out, and only then report success: after the new tasks have proved they stay up. */
export async function runDeploy(
  deps: AppDeps,
  target: ServiceTarget,
  ctx: ActionContext,
  options: DeployOptions = {},
): Promise<void> {
  const record = requireService(deps, target);
  const name = qualifiedName(target.projectName, target.serviceName);
  const existing = await deps.docker.inspectService(name);
  const forceUpdate = existing === null ? 0 : (existing.spec.TaskTemplate.ForceUpdate ?? 0) + 1;
  let plan = planDeployment(deps, target, record, forceUpdate);

  await prepareNetwork(deps, target, ctx);

  const registryAuth = registryAuthFor(deps, plan.source);
  if (plan.source.type === "image") {
    ctx.log(`Pulling image ${plan.source.image}`);
    await deps.docker.pullImage(plan.source.image, {
      registryAuth,
      signal: ctx.signal,
      onProgress: logPullProgress(ctx),
    });
  } else {
    const built = await buildServiceImage(deps, target, record, ctx, { force: options.force === true });
    plan = planDeployment(deps, target, record, forceUpdate, built.gitSha);
  }

  await prepareMounts(deps, target, plan.compiled);
  const previous = await currentTaskIds(deps, name, existing !== null);
  if (existing === null) {
    ctx.log(`Creating the Swarm service ${name}`);
    await deps.docker.createService(plan.swarmSpec, { registryAuth });
  } else {
    ctx.log(`Updating the Swarm service ${name}`);
    await deps.docker.updateService(name, plan.swarmSpec, { registryAuth });
  }

  const spec = setStopped(deps, target, record, false);
  await writeProxyConfig(deps, target, spec);

  const desired = currentReplicas(plan.swarmSpec);
  ctx.log(`Waiting for ${desired} new task${desired === 1 ? "" : "s"} to settle`);
  await waitForRollout({
    docker: deps.docker,
    timing: deps.rollout,
    service: name,
    desired,
    previousTaskIds: previous,
    signal: ctx.signal,
    log: ctx.log,
  });
  ctx.log(`Deployed ${plan.swarmSpec.TaskTemplate.ContainerSpec.Image}`);
}

async function runStop(deps: AppDeps, target: ServiceTarget, ctx: ActionContext): Promise<void> {
  const record = requireService(deps, target);
  const name = qualifiedName(target.projectName, target.serviceName);
  const swarm = await requireSwarmService(deps, name);

  ctx.log(`Scaling ${name} to zero`);
  await deps.docker.updateService(name, withReplicas(swarm.spec, 0));
  await writeProxyConfig(deps, target, setStopped(deps, target, record, true));
  await waitForShutdown({
    docker: deps.docker,
    timing: deps.rollout,
    service: name,
    signal: ctx.signal,
    log: ctx.log,
  });
  ctx.log("Stopped");
}

async function runStart(deps: AppDeps, target: ServiceTarget, ctx: ActionContext): Promise<void> {
  const record = requireService(deps, target);
  const name = qualifiedName(target.projectName, target.serviceName);
  const existing = await deps.docker.inspectService(name);
  const registryAuth = record.spec.source === null ? undefined : registryAuthFor(deps, record.spec.source);
  const previous = await currentTaskIds(deps, name, existing !== null);

  let desired: number;
  if (existing === null) {
    // A rename removes the stopped Swarm service, so the first start creates it again. A built
    // image is tagged with the service's name, so it has to be built again under the new one.
    const source = record.spec.source;
    const built =
      source !== null && source.type !== "image"
        ? await buildServiceImage(deps, target, record, ctx, { force: false })
        : null;
    const plan = planDeployment(deps, target, record, 0, built?.gitSha ?? null);
    await prepareNetwork(deps, target, ctx);
    await prepareMounts(deps, target, plan.compiled);
    ctx.log(`Creating the Swarm service ${name}`);
    await deps.docker.createService(plan.swarmSpec, { registryAuth });
    desired = currentReplicas(plan.swarmSpec);
  } else {
    desired = record.spec.deploy.replicas;
    ctx.log(`Scaling ${name} to ${desired}`);
    await deps.docker.updateService(name, withReplicas(existing.spec, desired), { registryAuth });
  }

  await writeProxyConfig(deps, target, setStopped(deps, target, record, false));
  await waitForRollout({
    docker: deps.docker,
    timing: deps.rollout,
    service: name,
    desired,
    previousTaskIds: previous,
    signal: ctx.signal,
    log: ctx.log,
  });
  ctx.log("Started");
}

async function runRestart(deps: AppDeps, target: ServiceTarget, ctx: ActionContext): Promise<void> {
  const record = requireService(deps, target);
  const name = qualifiedName(target.projectName, target.serviceName);
  const swarm = await requireSwarmService(deps, name);
  const registryAuth = record.spec.source === null ? undefined : registryAuthFor(deps, record.spec.source);
  const previous = await currentTaskIds(deps, name, true);

  ctx.log(`Replacing the tasks of ${name}`);
  const { TaskTemplate } = swarm.spec;
  await deps.docker.updateService(
    name,
    { ...swarm.spec, TaskTemplate: { ...TaskTemplate, ForceUpdate: (TaskTemplate.ForceUpdate ?? 0) + 1 } },
    { registryAuth },
  );
  await waitForRollout({
    docker: deps.docker,
    timing: deps.rollout,
    service: name,
    desired: currentReplicas(swarm.spec),
    previousTaskIds: previous,
    signal: ctx.signal,
    log: ctx.log,
  });
  ctx.log("Restarted");
}

/** Removes a service from Docker, the proxy, the disk and the database, in that order. */
export async function removeServiceEverywhere(
  deps: AppDeps,
  target: ServiceTarget,
  log: (line: string) => void,
): Promise<void> {
  const record = findService(deps.db, target.projectName, target.serviceName);
  const source = record?.spec.source;
  if (source?.type === "github" && source.webhookId !== null) {
    await deleteRepositoryHook(deps, source.repository, source.webhookId);
  }
  log(`Removing the Swarm service ${qualifiedName(target.projectName, target.serviceName)}`);
  await deps.docker.removeService(qualifiedName(target.projectName, target.serviceName));
  log("Removing the routes");
  await deps.proxy.removeService(target.projectName, target.serviceName);
  log("Removing the service's data directory");
  await rm(serviceDir(deps, target.projectName, target.serviceName), { recursive: true, force: true });
  await removeServiceVolumes(deps, target);
  if (record !== undefined && isDatabaseRecord(record)) {
    await removeDatabaseLeftovers(deps, target, record, log);
  }
  deleteServiceRow(deps.db, target.projectName, target.serviceName);
}

async function requireSwarmService(deps: AppDeps, name: string): Promise<ServiceInfo> {
  const swarm = await deps.docker.inspectService(name);
  if (swarm === null) {
    throw new Error("This service has not been deployed yet.");
  }
  return swarm;
}

function assertDeployed(swarm: ServiceInfo | null): asserts swarm is ServiceInfo {
  if (swarm === null) {
    throw conflict("service_not_deployed", "Deploy this service first.");
  }
}

/** A stopped service may be set to zero replicas, but there would be nothing to bring back up. */
function assertHasReplicas(spec: AppServiceSpec): void {
  if (spec.deploy.replicas < 1) {
    throw conflict("service_has_no_replicas", "Set at least one replica before starting this service.");
  }
}

function enqueue(
  deps: AppDeps,
  target: ServiceTarget,
  verb: { type: string; title: string },
  actorEmail: string | undefined,
  run: (ctx: ActionContext) => Promise<void>,
): ActionRow {
  return deps.actions.enqueue({
    type: verb.type,
    title: `${verb.title} ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
    run,
  });
}

export function enqueueDeploy(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
  options: DeployOptions = {},
): ActionRow {
  const { spec } = requireService(deps, target);
  if (spec.source === null) {
    throw conflict("service_has_no_source", "Save a source before deploying.");
  }
  assertHasReplicas(spec);
  return enqueue(deps, target, { type: deployActionType, title: "Deploy" }, actorEmail, (ctx) =>
    runDeploy(deps, target, ctx, options),
  );
}

export async function enqueueStop(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): Promise<ActionRow> {
  const record = requireService(deps, target);
  const swarm = await deps.docker.inspectService(qualifiedName(target.projectName, target.serviceName));
  assertDeployed(swarm);
  if (record.spec.stopped) {
    throw conflict("service_stopped", "This service is already stopped.");
  }
  return enqueue(deps, target, { type: "service.stop", title: "Stop" }, actorEmail, (ctx) =>
    runStop(deps, target, ctx),
  );
}

export async function enqueueStart(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): Promise<ActionRow> {
  const record = requireService(deps, target);
  if (!record.spec.stopped) {
    const swarm = await deps.docker.inspectService(qualifiedName(target.projectName, target.serviceName));
    assertDeployed(swarm);
    throw conflict("service_running", "This service is already running.");
  }
  assertHasReplicas(record.spec);
  return enqueue(deps, target, { type: "service.start", title: "Start" }, actorEmail, (ctx) =>
    runStart(deps, target, ctx),
  );
}

export async function enqueueRestart(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): Promise<ActionRow> {
  const record = requireService(deps, target);
  const swarm = await deps.docker.inspectService(qualifiedName(target.projectName, target.serviceName));
  assertDeployed(swarm);
  if (record.spec.stopped) {
    throw conflict("service_stopped", "Start this service first.");
  }
  return enqueue(deps, target, { type: "service.restart", title: "Restart" }, actorEmail, (ctx) =>
    runRestart(deps, target, ctx),
  );
}

export function enqueueDestroy(
  deps: AppDeps,
  target: ServiceTarget,
  confirm: string,
  actorEmail: string | undefined,
): ActionRow {
  requireService(deps, target);
  if (confirm !== target.serviceName) {
    throw conflict("confirmation_mismatch", "Type the service's exact name to confirm.", {
      confirm: "Does not match the service's name",
    });
  }
  return enqueue(deps, target, { type: "service.destroy", title: "Destroy" }, actorEmail, async (ctx) => {
    if (findService(deps.db, target.projectName, target.serviceName) === undefined) {
      ctx.log("This service is already gone.");
      return;
    }
    await removeServiceEverywhere(deps, target, ctx.log);
    ctx.log("Destroyed");
  });
}

/** Runs the rename as an Action, so it queues behind other work, and answers when it has finished. */
export async function renameService(
  deps: AppDeps,
  from: ServiceTarget,
  request: RenameServiceRequest,
  actorEmail: string | undefined,
): Promise<ServiceTarget> {
  await validateRename(deps, from, request);
  const to = { projectName: request.projectName, serviceName: request.name };

  await new Promise<void>((resolve, reject) => {
    enqueue(deps, from, { type: "service.rename", title: "Rename" }, actorEmail, async (ctx) => {
      try {
        await performRename(deps, from, request, ctx.log);
        ctx.log(`Renamed to ${to.projectName}/${to.serviceName}`);
        resolve();
      } catch (error) {
        reject(error);
        throw error;
      }
    });
  });
  return to;
}
