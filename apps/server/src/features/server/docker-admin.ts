import type {
  CleanupItem,
  CleanupPreview,
  DockerCleanupKind,
  DockerEngine,
  DockerEngineWarning,
  DockerFeature,
  DockerUpdateCheck,
} from "@opsifier/contract";
import type { ActionContext, ActionRow } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import {
  cliProblems,
  compareVersions,
  DockerDriverError,
  engineProblems,
  type ImageInfo,
  MINIMUM_DOCKER_API,
  MINIMUM_DOCKER_VERSION,
} from "../../core/docker";
import { conflict } from "../../core/errors";
import { listProjects } from "../projects/repo";
import { listAllReleaseKeys } from "../releases/repo";
import { dockerCliEnv } from "../service-tabs/source/build/environment";
import { builtImageName, projectOfNetwork, releaseImageName } from "../services/compile/names";
import { listServiceRecords } from "../services/repo";
import { getSetting, putSetting } from "../system/repo";
import { formatSize, readDockerDisk } from "./disk";

const OWNED_IMAGES_KEY = "owned_image_ids";
const MAX_OWNED_IMAGES = 1024;
const OWNED_BUILD_CACHE_KEY = "owned_build_cache_ids";
const MAX_OWNED_BUILD_CACHE = 10_000;
const OWN_IMAGE_PREFIX = "opsifier/";
const CHECK_TIMEOUT_MS = 8000;

const warningOf = (feature: DockerFeature): DockerEngineWarning =>
  feature === "version" ? "too-old" : feature === "swarm" ? "swarm-inactive" : "unsupported";

/** What Docker says it can do, and what the panel has found it can't, from its own answers. */
export async function readDockerEngine(
  deps: Pick<AppDeps, "docker" | "tools" | "config">,
): Promise<DockerEngine> {
  try {
    const info = await deps.docker.engineInfo();
    const problems = [
      ...engineProblems(info),
      ...(await cliProblems({ tools: deps.tools, env: dockerCliEnv(deps) })),
    ];
    const missing = problems.map(({ feature }) => feature);
    return {
      available: true,
      version: info.version,
      apiVersion: info.apiVersion,
      minimumVersion: MINIMUM_DOCKER_VERSION,
      minimumApiVersion: MINIMUM_DOCKER_API,
      swarm: info.swarm,
      missing,
      warnings: [...new Set(missing.map(warningOf))],
    };
  } catch (error) {
    if (!(error instanceof DockerDriverError)) {
      throw error;
    }
    return {
      available: false,
      version: null,
      apiVersion: null,
      minimumVersion: MINIMUM_DOCKER_VERSION,
      minimumApiVersion: MINIMUM_DOCKER_API,
      swarm: null,
      missing: [],
      warnings: ["unavailable"],
    };
  }
}

/** Says whether a newer engine exists. It never touches the host: upgrading it is left to its owner. */
export async function checkDockerUpdate(deps: AppDeps): Promise<DockerUpdateCheck> {
  const engine = await readDockerEngine(deps);
  const checkedAt = new Date(deps.now()).toISOString();
  const current = engine.version ?? "unknown";
  if (engine.version === null) {
    return {
      current,
      latest: null,
      upToDate: null,
      notes: null,
      problem: "Docker is not answering.",
      checkedAt,
      engine,
    };
  }

  try {
    const response = await fetch(deps.config.dockerReleasesUrl, {
      headers: { accept: "application/vnd.github+json", "user-agent": "opsifier" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        current,
        latest: null,
        upToDate: null,
        notes: null,
        problem: `The release feed answered ${response.status}.`,
        checkedAt,
        engine,
      };
    }
    const body = (await response.json()) as { tag_name?: string; name?: string };
    const latest = (body.tag_name ?? body.name ?? "").replace(/^docker-/, "").replace(/^v/, "");
    if (latest === "") {
      return {
        current,
        latest: null,
        upToDate: null,
        notes: null,
        problem: "The release feed gave no version.",
        checkedAt,
        engine,
      };
    }
    return {
      current,
      latest,
      upToDate: compareVersions(engine.version, latest) >= 0,
      notes: null,
      problem: null,
      checkedAt,
      engine,
    };
  } catch (error) {
    return {
      current,
      latest: null,
      upToDate: null,
      notes: null,
      problem: `The release feed could not be reached: ${error instanceof Error ? error.message : "unknown error"}.`,
      checkedAt,
      engine,
    };
  }
}

function readOwnedImages(deps: Pick<AppDeps, "db">): string[] {
  const stored = getSetting(deps.db, OWNED_IMAGES_KEY);
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Notes the id of every image the panel built, while it still has its tag. When the next build takes
 * the tag away, the leftover is only attributable to the panel because this remembered it.
 */
export function rememberOwnedImages(deps: Pick<AppDeps, "db" | "now">, images: readonly ImageInfo[]): void {
  const known = new Set(readOwnedImages(deps));
  const before = known.size;
  for (const image of images) {
    if (image.tags.some((tag) => tag.startsWith(OWN_IMAGE_PREFIX))) {
      known.add(image.id);
    }
  }
  if (known.size !== before) {
    putSetting(deps.db, OWNED_IMAGES_KEY, [...known].slice(-MAX_OWNED_IMAGES), new Date(deps.now()));
  }
}

/**
 * The images a service still needs to start, whether or not anything runs them now. A built image
 * exists only on this server, so a stopped service whose image is gone could not come back.
 */
function ownedImageRefs(deps: Pick<AppDeps, "db">): Set<string> {
  const refs = new Set<string>();
  for (const record of listServiceRecords(deps.db)) {
    const { source } = record.spec;
    if (source?.type === "image") {
      refs.add(source.image);
      refs.add(`${source.image}:latest`);
    } else if (source !== null) {
      refs.add(builtImageName(record.projectName, record.name));
    }
    if (record.deployed !== null) {
      // What it last ran, which saved settings may have moved away from.
      refs.add(record.deployed.image);
    }
  }
  // A version kept for going back has no other claim to its image, and must never lose it.
  for (const { serviceId, number } of listAllReleaseKeys(deps.db)) {
    refs.add(releaseImageName(serviceId, number));
  }
  return refs;
}

function readOwnedBuildCache(deps: Pick<AppDeps, "db">): string[] {
  const stored = getSetting(deps.db, OWNED_BUILD_CACHE_KEY);
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
}

/** What the builder holds before a build starts, or null if that can't be read. */
export async function snapshotBuildCache(
  deps: Pick<AppDeps, "docker">,
  signal?: AbortSignal,
): Promise<ReadonlySet<string> | null> {
  try {
    return new Set((await deps.docker.listBuildCache({ signal })).map((record) => record.id));
  } catch {
    return null;
  }
}

/**
 * Docker records no owner for build cache, so the panel notes what appeared while one of its own
 * builds ran. Anything it never saw appear stays someone else's, and no cleanup will offer it.
 */
export async function rememberBuildCache(
  deps: Pick<AppDeps, "db" | "docker" | "now">,
  before: ReadonlySet<string> | null,
): Promise<void> {
  if (before === null) {
    return;
  }
  try {
    const created = (await deps.docker.listBuildCache())
      .filter((record) => !before.has(record.id))
      .map((record) => record.id);
    if (created.length > 0) {
      const known = new Set([...readOwnedBuildCache(deps), ...created]);
      putSetting(
        deps.db,
        OWNED_BUILD_CACHE_KEY,
        [...known].slice(-MAX_OWNED_BUILD_CACHE),
        new Date(deps.now()),
      );
    }
  } catch {
    // It stays unattributed, which only means no cleanup will ever offer to remove it.
  }
}

/** Something the panel can answer for: built by it, or the image one of its services names. */
function isOwnedImage(image: ImageInfo, knownIds: ReadonlySet<string>, refs: ReadonlySet<string>): boolean {
  return (
    image.tags.some((tag) => tag.startsWith(OWN_IMAGE_PREFIX) || refs.has(tag)) ||
    // A remembered id only counts once the image has no name of its own left: someone else's tag wins.
    (image.tags.length === 0 && knownIds.has(image.id)) ||
    Object.keys(image.labels).some((label) => label.startsWith("opsifier."))
  );
}

const imageLabel = (image: ImageInfo) =>
  image.tags.find((tag) => tag.startsWith(OWN_IMAGE_PREFIX)) ??
  image.tags[0] ??
  `<none> ${image.id.replace(/^sha256:/, "").slice(0, 12)}`;

/** A cleanup item, with what removing it means for the driver. Only `CleanupItem` reaches the API. */
interface PlannedItem extends CleanupItem {
  references?: string[];
}

interface Plan extends Omit<CleanupPreview, "items"> {
  items: PlannedItem[];
}

const isSwarmManaged = (labels: Record<string, string>) =>
  labels["com.docker.swarm.service.name"] !== undefined;

/** What the API shows of a plan: exactly what will be removed, with nothing private in it. */
export async function previewCleanup(deps: AppDeps, kind: DockerCleanupKind): Promise<CleanupPreview> {
  const plan = await planCleanup(deps, kind);
  return {
    ...plan,
    items: plan.items.map(({ id, type, label, sizeBytes }) => ({ id, type, label, sizeBytes })),
  };
}

/** Everything a cleanup of this kind is allowed to consider, freshly read. Never a volume. */
async function planCleanup(deps: AppDeps, kind: DockerCleanupKind): Promise<Plan> {
  const [images, containers, buildCache, swarmServices] = await Promise.all([
    deps.docker.listImages(),
    deps.docker.listContainers(),
    deps.docker.listBuildCache(),
    deps.docker.listServices(),
  ]);
  rememberOwnedImages(deps, images);

  const knownIds = new Set(readOwnedImages(deps));
  const refs = ownedImageRefs(deps);
  const usedImageIds = new Set(containers.map((container) => container.imageId));
  const items: PlannedItem[] = [];
  const retained: CleanupPreview["retained"] = [];
  let foreignCount = 0;

  if (kind === "images" || kind === "system") {
    for (const image of images) {
      const ownTags = image.tags.filter((tag) => tag.startsWith(OWN_IMAGE_PREFIX) || refs.has(tag));
      if (usedImageIds.has(image.id)) {
        if (isOwnedImage(image, knownIds, refs)) {
          retained.push({ label: imageLabel(image), reason: "in-use" });
        }
      } else if (!isOwnedImage(image, knownIds, refs)) {
        foreignCount += 1;
      } else if (image.tags.some((tag) => refs.has(tag))) {
        // Its service could be started again at any moment.
        retained.push({ label: imageLabel(image), reason: "rollback" });
      } else {
        // Only the panel's own tags are removed. An image other tags still point to stays where it is.
        items.push({
          id: `image:${image.id}`,
          type: "image",
          label: imageLabel(image),
          sizeBytes: image.sizeBytes,
          references: ownTags.length > 0 ? ownTags : [image.id],
        });
      }
    }
  }

  if (kind === "builder" || kind === "system") {
    const ownedCache = new Set(readOwnedBuildCache(deps));
    for (const record of buildCache) {
      if (!ownedCache.has(record.id)) {
        foreignCount += 1;
      } else if (record.inUse || record.shared) {
        retained.push({ label: record.description || record.id, reason: record.inUse ? "in-use" : "shared" });
      } else {
        items.push({
          id: `build-cache:${record.id}`,
          type: "build-cache",
          label: record.description || record.id,
          sizeBytes: record.sizeBytes,
        });
      }
    }
  }

  if (kind === "system") {
    const projectSet = new Set(listProjects(deps.db).map((project) => project.name));
    const liveServiceNames = new Set(swarmServices.map((service) => service.name));
    for (const container of containers) {
      if (container.state === "running" || container.state === "restarting" || container.state === "paused") {
        continue;
      }
      const serviceName = container.labels["com.docker.swarm.service.name"];
      const owned =
        container.labels["opsifier.helper"] !== undefined ||
        (serviceName !== undefined &&
          (projectSet.has(serviceName.split("_", 1)[0] ?? "") || liveServiceNames.has(serviceName)));
      if (!owned) {
        if (!isSwarmManaged(container.labels)) {
          foreignCount += 1;
        }
        continue;
      }
      items.push({
        id: `container:${container.id}`,
        type: "container",
        label: container.name || container.id.slice(0, 12),
        sizeBytes: container.sizeBytes,
      });
    }

    const projectNetworks = await deps.docker.listNetworks();
    for (const network of projectNetworks) {
      const project = projectOfNetwork(network.name);
      if (project === null || network.driver === "host") {
        continue;
      }
      if (!projectSet.has(project)) {
        items.push({ id: `network:${network.name}`, type: "network", label: network.name, sizeBytes: null });
      }
    }
  }

  return {
    kind,
    items,
    retained,
    foreignCount,
    reclaimableBytes: items.reduce((total, item) => total + (item.sizeBytes ?? 0), 0),
  };
}

/** Takes a fresh inventory and removes only what was both selected and is still eligible. */
async function removeSelected(
  deps: AppDeps,
  kind: DockerCleanupKind,
  selection: ReadonlySet<string> | null,
  ctx: ActionContext,
): Promise<void> {
  const plan = await planCleanup(deps, kind);
  const chosen = selection === null ? plan.items : plan.items.filter((item) => selection.has(item.id));
  if (selection !== null && chosen.length < selection.size) {
    ctx.log(
      `${selection.size - chosen.length} of the selected items are no longer eligible and were left alone.`,
    );
  }

  const usageBefore = await reclaimableUsage(deps);
  const diskBefore = await readDockerDisk(deps, ctx.signal);
  let removed = 0;
  for (const item of chosen) {
    ctx.signal.throwIfAborted();
    const [type, id = ""] = splitItemId(item.id);
    try {
      if (type === "image") {
        for (const reference of item.references ?? [id]) {
          await deps.docker.removeImage(reference);
        }
      } else if (type === "container") {
        await deps.docker.removeContainer(id);
      } else if (type === "network") {
        await deps.docker.removeNetwork(id);
      } else if (type === "build-cache") {
        await deps.docker.removeBuildCache([id]);
      }
      removed += 1;
      ctx.log(`Removed ${item.label}`);
    } catch (error) {
      // Something else started using it in the meantime. That is the cleanup working, not failing.
      ctx.log(
        `Left ${item.label} in place: ${error instanceof Error ? error.message : "it could not be removed"}`,
      );
    }
  }

  const expected = chosen.reduce((total, item) => total + (item.sizeBytes ?? 0), 0);
  const usageAfter = await reclaimableUsage(deps);
  const diskAfter = await readDockerDisk(deps, ctx.signal);
  const freed = usageBefore === null || usageAfter === null ? null : Math.max(0, usageBefore - usageAfter);
  ctx.log(
    `Done: ${removed} of ${chosen.length} item${chosen.length === 1 ? "" : "s"} removed, expected to free ${formatSize(expected)}.`,
  );
  ctx.log(
    freed === null
      ? "Docker did not report how much space that gave back."
      : `Docker reports ${formatSize(freed)} given back.`,
  );
  if (diskBefore !== null && diskAfter !== null) {
    ctx.log(
      `Free space on Docker's disk went from ${formatSize(diskBefore.freeBytes)} to ${formatSize(diskAfter.freeBytes)}.`,
    );
  }
}

/** Everything a cleanup can give back, by Docker's own count. Layers shared between images count once. */
async function reclaimableUsage(deps: Pick<AppDeps, "docker">): Promise<number | null> {
  try {
    const usage = await deps.docker.diskUsage();
    return usage.imagesBytes + usage.containersBytes + usage.buildCacheBytes;
  } catch {
    return null;
  }
}

function splitItemId(id: string): [string, string] {
  const separator = id.indexOf(":");
  return [id.slice(0, separator), id.slice(separator + 1)];
}

export const cleanupConfirmWord = (kind: DockerCleanupKind) => kind;

const cleanupTitles: Record<DockerCleanupKind, string> = {
  images: "Clean Docker images",
  builder: "Clean the build cache",
  system: "Prune unused Docker data",
};

export function enqueueCleanup(
  deps: AppDeps,
  kind: DockerCleanupKind,
  items: readonly string[],
  confirm: string,
  actorEmail: string | undefined,
): ActionRow {
  if (confirm !== cleanupConfirmWord(kind)) {
    throw conflict("confirmation_mismatch", `Type ${cleanupConfirmWord(kind)} to confirm.`, {
      confirm: "Does not match",
    });
  }
  const selection = new Set(items);
  return deps.actions.enqueue({
    type: "docker.cleanup",
    title: cleanupTitles[kind],
    actorEmail,
    run: async (ctx) => {
      await removeSelected(deps, kind, selection, ctx);
    },
  });
}

/** The daily run: only what a person could have selected by hand, chosen without asking. */
export function enqueueDailyCleanup(deps: AppDeps): ActionRow {
  return deps.actions.enqueue({
    type: "docker.cleanup",
    title: "Daily Docker cleanup",
    run: async (ctx) => {
      await removeSelected(deps, "system", null, ctx);
    },
  });
}
