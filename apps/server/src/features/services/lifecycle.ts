import { mkdir, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deployActionType, type RenameServiceRequest } from "@opsifier/contract";
import type { ActionContext, ActionRow } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import type { RuntimeUncertainty } from "../../core/db/schema";
import {
  type PullProgress,
  type RegistryAuth,
  type ServiceInfo,
  type SwarmServiceSpec,
  waitForRollout,
  waitForShutdown,
} from "../../core/docker";
import { conflict } from "../../core/errors";
import { writeFileAtomic } from "../../core/proxy";
import { noteDeployment } from "../actions/repo";
import { deployBox } from "../box/deploy";
import {
  enqueueComposeDeploy,
  enqueueComposeRestart,
  enqueueComposeStart,
  enqueueComposeStop,
  removeComposeStack,
} from "../compose/lifecycle";
import { copyBeforeMajorChange } from "../databases/major-version";
import { databaseAvailability, isDatabaseRecord } from "../databases/service";
import { deleteRepositoryHook } from "../github/hooks";
import { assertProjectBoundaries } from "../projects/isolation";
import {
  ensureProjectNetwork,
  isOnSharedNetwork,
  prepareRoutedNetworks,
  releaseProxyFromProjectNetwork,
} from "../projects/network";
import { recordSuccess, removeReleases } from "../releases/service";
import { retainServiceVolumes } from "../retained-volumes/service";
import { moveCompanionsToProxyNetwork, removeAllCompanions } from "../service-tabs/companions/service";
import { deployDatabaseWithPort } from "../service-tabs/expose/service";
import { buildServiceImage } from "../service-tabs/source/build/pipeline";
import type { StoredSource } from "../service-tabs/source/stored";
import { prepareMounts } from "../service-tabs/storage/service";
import { compileDesired, effectiveOf, recordApplied } from "./applied";
import { checkAnswering } from "./availability";
import { type CompiledService, qualifiedName } from "./compile";
import type { MountFile } from "./compile/mounts";
import { builtImageName, heldImageName } from "./compile/names";
import { type DeployRequest, deployRun, joinDeployRun } from "./deploy-request";
import { assertDeploySpace, buildDiskNeed, imageDiskNeed } from "./disk-check";
import { firstPortInUse, PortInUseError } from "./host-ports";
import { type ImageIdentity, pinnedReference, resolveImage } from "./image-identity";
import { inspectOwnedService, removeOwnedService } from "./ownership";
import {
  deleteServiceRow,
  findService,
  type ServiceRecord,
  saveRuntimeUncertain,
  saveServiceSpec,
} from "./repo";
import { assertRuntimeCertain } from "./runtime-state";
import {
  performRename,
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

export function withImage(spec: SwarmServiceSpec, image: string): SwarmServiceSpec {
  return {
    ...spec,
    TaskTemplate: {
      ...spec.TaskTemplate,
      ContainerSpec: { ...spec.TaskTemplate.ContainerSpec, Image: image },
    },
  };
}

/** The tasks that exist now. A rollout is finished when different tasks have replaced them. */
async function currentTaskIds(deps: AppDeps, name: string, exists: boolean): Promise<Set<string>> {
  if (!exists) {
    return new Set();
  }
  return new Set((await deps.docker.listTasks({ service: name })).map((task) => task.id));
}

/** Read here and not when the work began: whatever was saved in the meantime has to stay saved. */
function setStopped(deps: AppDeps, target: ServiceTarget, stopped: boolean): AppServiceSpec {
  const spec = { ...requireService(deps, target).spec, stopped };
  saveServiceSpec(deps.db, target.projectName, target.serviceName, spec, new Date(deps.now()));
  return spec;
}

export interface DeployOptions extends DeployRequest {}

interface DeploymentPlan {
  compiled: CompiledService;
  swarmSpec: SwarmServiceSpec;
  source: StoredSource;
  /** What to record as applied if this plan succeeds. From the same moment as the rest of it. */
  effective: unknown;
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
  const compiled = compileDesired(deps, target, record, forceUpdate, gitSha);
  if (compiled.swarmSpec === null) {
    throw new Error("This service has no source to deploy.");
  }
  return { compiled, swarmSpec: compiled.swarmSpec, source, effective: effectiveOf(deps, target, record) };
}

export async function writeMountFiles(files: DeploymentPlan["compiled"]["files"]): Promise<void> {
  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(file.path, file.content, file.mode ?? 0o600);
  }
}

export async function prepareNetwork(
  deps: AppDeps,
  target: ServiceTarget,
  ctx: ActionContext,
): Promise<void> {
  ctx.log(`Preparing the network of ${target.projectName}`);
  if (isDatabaseRecord(requireService(deps, target))) {
    await ensureProjectNetwork(deps.docker, target.projectName);
  } else {
    await prepareRoutedNetworks(deps, target.projectName, ctx.log);
  }
}

/** What a deployment keeps of the image it replaces, in case it has to go back. */
export interface OutgoingImage {
  /** A name of its own for the image, which nothing else moves. */
  heldImage: string | null;
  /** What the spec's image tag meant before this deployment. A pull or a build moves a tag. */
  imageId: string | null;
}

/** What a deployment is about to replace, kept so that it can be put back. */
interface ReplacedRuntime extends OutgoingImage {
  version: number;
  spec: SwarmServiceSpec;
  taskIds: ReadonlySet<string>;
  stopped: boolean;
  /** What its file mounts held, since a failed update can't leave those changed either. */
  files: MountFile[];
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The error to report, with what became of the previous version. */
const withOutcome = (error: unknown, outcome: string): Error =>
  new Error(`${describeError(error)} ${outcome}`, { cause: error });

async function imageIdOf(deps: Pick<AppDeps, "docker">, spec: SwarmServiceSpec): Promise<string | null> {
  const image = await deps.docker.inspectImage(spec.TaskTemplate.ContainerSpec.Image).catch(() => null);
  return image?.id ?? null;
}

/**
 * Gives the outgoing image a name no pull or build can move. Docker's image store drops an image
 * the moment its last tag moves away, whatever containers still refer to it by ID, so without this
 * there would be nothing to go back to.
 */
async function holdOutgoingImage(
  deps: Pick<AppDeps, "docker">,
  target: ServiceTarget,
  spec: SwarmServiceSpec,
  ctx: ActionContext,
): Promise<string | null> {
  const image = spec.TaskTemplate.ContainerSpec.Image;
  const held = heldImageName(target.projectName, target.serviceName);
  if (image !== held && (await deps.docker.inspectImage(image)) === null) {
    return null;
  }
  try {
    if (image !== held) {
      await deps.docker.tagImage(image, held);
    }
    return held;
  } catch (error) {
    ctx.log(`Could not set the current image aside: ${describeError(error)}`);
    return null;
  }
}

/** Run before the pull or the build, which can move the tag to something else. */
export async function setOutgoingImageAside(
  deps: Pick<AppDeps, "docker">,
  target: ServiceTarget,
  spec: SwarmServiceSpec,
  ctx: ActionContext,
): Promise<OutgoingImage> {
  const imageId = await imageIdOf(deps, spec);
  return { imageId, heldImage: await holdOutgoingImage(deps, target, spec, ctx) };
}

/** Fails while nothing has been replaced yet, instead of with the old task already stopped. */
async function assertPortsAvailable(
  deps: AppDeps,
  target: ServiceTarget,
  swarmSpec: SwarmServiceSpec,
): Promise<void> {
  const clash = await firstPortInUse(
    deps,
    target,
    (swarmSpec.EndpointSpec?.Ports ?? []).flatMap((entry) =>
      entry.PublishedPort === undefined
        ? []
        : [{ protocol: entry.Protocol === "udp" ? "udp" : "tcp", port: entry.PublishedPort }],
    ),
  );
  if (clash !== null) {
    throw new PortInUseError(
      `Port ${clash.port}/${clash.protocol} is already in use on this server, so nothing was replaced.`,
    );
  }
}

/**
 * Puts the previous version back after a failed update, and answers when it is running again. A
 * tag that a pull or a build has moved no longer means what ran before, so the held name is used
 * instead. Tasks the rollout never got round to replacing count as being back: they are still up,
 * and go only once Swarm has started their replacements.
 */
async function restorePrevious(
  deps: AppDeps,
  target: ServiceTarget,
  ctx: ActionContext,
  replaced: ReplacedRuntime,
  registryAuth: RegistryAuth | undefined,
): Promise<"restored" | "untouched"> {
  const name = qualifiedName(target.projectName, target.serviceName);
  const current = await deps.docker.inspectService(name);
  if (current?.version === replaced.version) {
    return "untouched";
  }

  ctx.log("Putting the previous version back");
  const imageMoved =
    replaced.heldImage !== null && (await imageIdOf(deps, replaced.spec)) !== replaced.imageId;
  // Right before the update: a restart of a failing task must not be mistaken for the restored ones.
  const tasks = await deps.docker.listTasks({ service: name });
  const survivors = tasks.filter(
    (task) => replaced.taskIds.has(task.id) && task.state === "running" && task.desiredState === "running",
  );
  const desired = currentReplicas(replaced.spec);
  const spec =
    imageMoved && replaced.heldImage !== null ? withImage(replaced.spec, replaced.heldImage) : replaced.spec;

  await deps.docker.updateService(name, spec, { registryAuth });
  await waitForRollout({
    docker: deps.docker,
    timing: deps.rollout,
    service: name,
    desired,
    previousTaskIds: new Set(tasks.filter((task) => !survivors.includes(task)).map((task) => task.id)),
    log: ctx.log,
  });
  if (replaced.stopped) {
    await writeProxyConfig(deps, target, setStopped(deps, target, true));
  }
  return "restored";
}

/** Leaves a failed deployment in a state that can be stated, and returns the error to report. */
async function settleFailedDeployment(
  deps: AppDeps,
  target: ServiceTarget,
  ctx: ActionContext,
  failure: {
    error: unknown;
    replaced: ReplacedRuntime | null;
    uncertainBefore: RuntimeUncertainty | null;
    registryAuth: RegistryAuth | undefined;
  },
): Promise<unknown> {
  const { error, replaced, uncertainBefore, registryAuth } = failure;
  const { projectName, serviceName } = target;
  if (replaced === null) {
    saveRuntimeUncertain(deps.db, projectName, serviceName, uncertainBefore);
    return error;
  }
  try {
    await writeMountFiles(replaced.files);
    const outcome = await restorePrevious(deps, target, ctx, replaced, registryAuth);
    saveRuntimeUncertain(deps.db, projectName, serviceName, uncertainBefore);
    if (outcome === "untouched") {
      return error;
    }
    ctx.log("The previous version is running again");
    return withOutcome(error, "The previous version is running again.");
  } catch (restoreError) {
    saveRuntimeUncertain(deps.db, projectName, serviceName, { reason: "restore_failed", actionId: ctx.id });
    ctx.log(`Could not put the previous version back: ${describeError(restoreError)}`);
    return withOutcome(
      error,
      "The previous version could not be put back, so what is running is uncertain until a deployment succeeds.",
    );
  }
}

/** What a replacement needs from whoever worked out what to run. */
export interface Replacement {
  swarmSpec: SwarmServiceSpec;
  compiled: Pick<CompiledService, "files" | "volumes">;
  existing: ServiceInfo | null;
  outgoing: OutgoingImage | null;
  registryAuth: RegistryAuth | undefined;
  /** Runs last before the switch, for what has to hold what the old version wrote right up to it. */
  beforeReplacing?: () => Promise<void>;
}

/** What a file mount holds now. A file that does not exist yet has nothing to be put back. */
async function readMountFiles(files: readonly MountFile[]): Promise<MountFile[]> {
  const read = await Promise.all(
    files.map(async (file) => ({
      file,
      content: await readFile(file.path, "utf8").catch(() => null),
    })),
  );
  return read.flatMap(({ file, content }) => (content === null ? [] : [{ ...file, content }]));
}

/**
 * Puts `swarmSpec` in place of what runs, whichever way it was arrived at, and answers whether the
 * result answers on its port. It watches the new tasks through a stability window, and if they don't
 * make it the previous version goes back with its files, and the error says so.
 */
export async function replaceRunningTasks(
  deps: AppDeps,
  target: ServiceTarget,
  ctx: ActionContext,
  { swarmSpec, compiled, existing, outgoing, registryAuth, beforeReplacing }: Replacement,
): Promise<boolean | null> {
  const { projectName, serviceName } = target;
  const name = qualifiedName(projectName, serviceName);

  ctx.phase("rollout");
  await assertPortsAvailable(deps, target, swarmSpec);
  const replacedFiles = await readMountFiles(compiled.files);
  await prepareMounts(deps, target, { ...compiled, swarmSpec }, ctx.log);
  if (beforeReplacing !== undefined) {
    await beforeReplacing();
    ctx.phase("rollout");
  }

  const previous = await currentTaskIds(deps, name, existing !== null);
  const replaced: ReplacedRuntime | null =
    existing === null
      ? null
      : {
          version: existing.version,
          spec: existing.spec,
          heldImage: outgoing?.heldImage ?? null,
          imageId: outgoing?.imageId ?? null,
          taskIds: previous,
          stopped: requireService(deps, target).spec.stopped,
          files: replacedFiles,
        };

  // Written first: should the panel die from here on, the flag outlives it and says so.
  const uncertainBefore = requireService(deps, target).runtimeUncertain;
  saveRuntimeUncertain(deps.db, projectName, serviceName, {
    reason: uncertainBefore?.reason ?? "interrupted",
    actionId: ctx.id,
  });

  try {
    if (existing === null) {
      ctx.log(`Creating the Swarm service ${name}`);
      await deps.docker.createService(swarmSpec, { registryAuth });
    } else {
      ctx.log(`Updating the Swarm service ${name}`);
      await deps.docker.updateService(name, swarmSpec, { registryAuth });
    }

    await writeProxyConfig(deps, target, setStopped(deps, target, false));

    const desired = currentReplicas(swarmSpec);
    ctx.phase("verify");
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
    return await checkAnswering(deps, target, ctx);
  } catch (error) {
    throw await settleFailedDeployment(deps, target, ctx, { error, replaced, uncertainBefore, registryAuth });
  }
}

/** The name a held image goes by is only for the length of a deployment. */
export async function releaseOutgoingImage(
  deps: Pick<AppDeps, "docker">,
  outgoing: OutgoingImage | null,
): Promise<void> {
  if (outgoing?.heldImage !== null && outgoing?.heldImage !== undefined) {
    // Refused while a stopped container still uses it. The next deployment replaces the name anyway.
    await deps.docker.removeImage(outgoing.heldImage).catch(() => undefined);
  }
}

/** What a deployment of a repository was asked to build: a push's commit, or the saved branch or tag. */
function requestedRefOf(source: StoredSource, commit: string | undefined): string | null {
  return source.type === "git" || source.type === "github" ? (commit ?? source.ref) : null;
}

/** Pull or build, roll out, and only then report success: after the new tasks have proved they stay up. */
export async function runDeploy(
  deps: AppDeps,
  target: ServiceTarget,
  ctx: ActionContext,
  options: DeployOptions = {},
): Promise<void> {
  const record = requireService(deps, target);
  const existing = await inspectOwnedService(deps, target);
  const forceUpdate = existing === null ? 0 : (existing.spec.TaskTemplate.ForceUpdate ?? 0) + 1;
  let plan = planDeployment(deps, target, record, forceUpdate);
  const requestedRef = requestedRefOf(plan.source, options.commit);
  noteDeployment(deps.db, ctx.id, {
    requestedRef,
    image: plan.source.type === "image" ? plan.source.image : null,
  });

  await assertProjectBoundaries(deps, target, record);
  const leavingSharedNetwork =
    existing !== null && isDatabaseRecord(record) && (await isOnSharedNetwork(deps.docker, existing));
  if (leavingSharedNetwork) {
    ctx.log(
      "This database is leaving the network databases used to share: only its own project can reach it from now on. Its address and connection strings stay the same.",
    );
  }

  await assertDeploySpace(
    deps,
    plan.source.type === "image"
      ? await imageDiskNeed(deps, plan.source.image)
      : await buildDiskNeed(deps, target),
    ctx,
  );

  await prepareNetwork(deps, target, ctx);

  const outgoing = existing === null ? null : await setOutgoingImageAside(deps, target, existing.spec, ctx);

  const registryAuth = registryAuthFor(deps, plan.source);
  let builtCommit: string | null = null;
  let identity: ImageIdentity;
  if (plan.source.type === "image") {
    ctx.phase("pull");
    ctx.log(`Pulling image ${plan.source.image}`);
    await deps.docker.pullImage(plan.source.image, {
      registryAuth,
      signal: ctx.signal,
      onProgress: logPullProgress(ctx),
    });
    identity = await resolveImage(deps, plan.source.image, { fromRegistry: true });
  } else {
    ctx.phase("build");
    const built = await buildServiceImage(deps, target, record, ctx, {
      force: options.force === true,
      commit: options.commit,
    });
    plan = planDeployment(deps, target, record, forceUpdate, built.gitSha);
    builtCommit = built.gitSha;
    identity = await resolveImage(deps, built.image, { fromRegistry: false });
  }

  // From here on the deployment deals in this answer, whatever a tag comes to mean in the meantime.
  const swarmSpec = withImage(plan.swarmSpec, pinnedReference(identity));
  ctx.log(`${identity.ref} is ${identity.digest ?? identity.id}`);
  if (identity.revision !== null) {
    ctx.log(`OCI revision ${identity.revision}`);
  }
  noteDeployment(deps.db, ctx.id, {
    image: identity.ref,
    imageId: identity.id,
    digest: identity.digest,
    builtCommit,
    ociRevision: identity.revision,
  });

  const replaced = existing;
  const answering = await replaceRunningTasks(deps, target, ctx, {
    swarmSpec,
    compiled: plan.compiled,
    existing,
    outgoing,
    registryAuth,
    beforeReplacing:
      replaced === null || !isDatabaseRecord(record)
        ? undefined
        : () =>
            copyBeforeMajorChange(
              deps,
              target,
              record,
              // Both by name, since a pinned digest says nothing about which major version it is.
              record.deployed?.image ?? replaced.spec.TaskTemplate.ContainerSpec.Image,
              plan.swarmSpec.TaskTemplate.ContainerSpec.Image,
              ctx,
            ),
  });

  await recordSuccess(deps, target, ctx, {
    identity,
    swarm: swarmSpec,
    compiled: plan.compiled,
    effective: plan.effective,
    requestedRef,
    builtCommit,
    rollbackOf: null,
    answering,
    desired: currentReplicas(swarmSpec),
  });
  await releaseOutgoingImage(deps, outgoing);
  if (leavingSharedNetwork) {
    await moveCompanionsToProxyNetwork(deps, target, ctx);
  }
  await releaseProxyFromProjectNetwork(deps.docker, target.projectName, ctx.log);
  ctx.log(`Deployed ${identity.digest ?? identity.ref}`);
}

/** Says whether the engine that just started really lets the panel in. It changes nothing either way. */
async function logDatabaseAvailability(
  deps: AppDeps,
  target: ServiceTarget,
  ctx: ActionContext,
): Promise<void> {
  try {
    const { signIn, detail } = await databaseAvailability(deps, target, ctx.signal);
    if (signIn === "accepted") {
      ctx.log("The database accepts the panel's credentials.");
    } else {
      ctx.log(`Deployed, but the panel could not sign in: ${detail ?? "no answer from the database."}`);
    }
  } catch (error) {
    ctx.log(`Deployed, but the panel could not check that it can sign in: ${(error as Error).message}`);
  }
}

async function runStop(deps: AppDeps, target: ServiceTarget, ctx: ActionContext): Promise<void> {
  const name = qualifiedName(target.projectName, target.serviceName);
  const swarm = await requireSwarmService(deps, target);

  ctx.log(`Scaling ${name} to zero`);
  await deps.docker.updateService(name, withReplicas(swarm.spec, 0));
  await writeProxyConfig(deps, target, setStopped(deps, target, true));
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
  const existing = await inspectOwnedService(deps, target);
  const registryAuth = record.spec.source === null ? undefined : registryAuthFor(deps, record.spec.source);
  const previous = await currentTaskIds(deps, name, existing !== null);

  let desired: number;
  let plan: DeploymentPlan | null = null;
  if (existing === null) {
    await assertProjectBoundaries(deps, target, record);
    // A rename removes the stopped Swarm service, so the first start creates it again. Starting never
    // builds anything: a rename carries a built image over, and without one there is nothing to start.
    const source = record.spec.source;
    if (source !== null && source.type !== "image") {
      const image = builtImageName(target.projectName, target.serviceName);
      if ((await deps.docker.inspectImage(image)) === null) {
        throw conflict(
          "image_missing",
          "This service's image is not on this server. Deploy it to build one.",
        );
      }
    }
    plan = planDeployment(deps, target, record, 0);
    await prepareNetwork(deps, target, ctx);
    await prepareMounts(deps, target, plan.compiled, ctx.log);
    ctx.log(`Creating the Swarm service ${name}`);
    await deps.docker.createService(plan.swarmSpec, { registryAuth });
    desired = currentReplicas(plan.swarmSpec);
  } else {
    desired = record.spec.deploy.replicas;
    ctx.log(`Scaling ${name} to ${desired}`);
    await deps.docker.updateService(name, withReplicas(existing.spec, desired), { registryAuth });
  }

  await writeProxyConfig(deps, target, setStopped(deps, target, false));
  await waitForRollout({
    docker: deps.docker,
    timing: deps.rollout,
    service: name,
    desired,
    previousTaskIds: previous,
    signal: ctx.signal,
    log: ctx.log,
  });
  if (plan !== null) {
    recordApplied(deps, target, plan.effective);
  }
  ctx.log("Started");
}

async function runRestart(deps: AppDeps, target: ServiceTarget, ctx: ActionContext): Promise<void> {
  const record = requireService(deps, target);
  const name = qualifiedName(target.projectName, target.serviceName);
  const swarm = await requireSwarmService(deps, target);
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

/** Everything in the service's folder except its volumes, which are not a service's to take with it. */
async function removeServiceFiles(deps: Pick<AppDeps, "config">, target: ServiceTarget): Promise<void> {
  const directory = serviceDir(deps, target.projectName, target.serviceName);
  const entries = await readdir(directory).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry !== "volumes")
      .map((entry) => rm(join(directory, entry), { recursive: true, force: true })),
  );
  // Only an empty folder can go, so one holding a kept volume stays.
  await rmdir(join(directory, "volumes")).catch(() => undefined);
  await rmdir(directory).catch(() => undefined);
}

/**
 * Removes a service from Docker, the proxy and the database, with the files that only made sense for
 * it. Named volumes and backups stay: deleting those is always a separate decision.
 */
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
  if (record?.spec.compose != null) {
    await removeComposeStack(deps, target, record, log);
  } else {
    await removeOwnedService(deps, target, log);
  }
  log("Removing the routes");
  await deps.proxy.removeService(target.projectName, target.serviceName);
  if (record !== undefined && isDatabaseRecord(record)) {
    await removeAllCompanions(deps, target, record, log);
  }
  log("Removing the service's files");
  await removeServiceFiles(deps, target);
  await removeReleases(deps, record, log);
  await retainServiceVolumes(deps, target, record, log);
  log("Backups stay at their destination");
  deleteServiceRow(deps.db, target.projectName, target.serviceName);
}

async function requireSwarmService(deps: AppDeps, target: ServiceTarget): Promise<ServiceInfo> {
  const swarm = await inspectOwnedService(deps, target);
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
  const record = requireService(deps, target);
  const { spec } = record;
  if (spec.compose !== null) {
    return enqueueComposeDeploy(deps, target, actorEmail, options);
  }
  if (spec.source === null) {
    throw conflict("service_has_no_source", "Save a source before deploying.");
  }
  assertHasReplicas(spec);
  const deploy = isDatabaseRecord(record)
    ? deployDatabaseWithPort
    : record.spec.box !== null
      ? deployBox
      : runDeploy;
  const work = async (request: DeployRequest, ctx: ActionContext) => {
    await deploy(deps, target, ctx, request);
    if (isDatabaseRecord(record)) {
      await logDatabaseAvailability(deps, target, ctx);
    }
  };
  return deps.actions.enqueue({
    type: deployActionType,
    title: `Deploy ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
    run: deployRun(options, work),
    join: (waiting) => joinDeployRun(waiting, options, work),
  });
}

export async function enqueueStop(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): Promise<ActionRow> {
  const record = requireService(deps, target);
  if (record.spec.compose !== null) {
    return enqueueComposeStop(deps, target, actorEmail);
  }
  assertDeployed(await inspectOwnedService(deps, target));
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
  if (record.spec.compose !== null) {
    return enqueueComposeStart(deps, target, actorEmail);
  }
  if (!record.spec.stopped) {
    assertDeployed(await inspectOwnedService(deps, target));
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
  if (record.spec.compose !== null) {
    return enqueueComposeRestart(deps, target, actorEmail);
  }
  assertDeployed(await inspectOwnedService(deps, target));
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
  assertRuntimeCertain(deps, target);
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
