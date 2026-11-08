import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  type BuildConfig,
  type EnvFileSettings,
  isBuildableSourceType,
  MAX_UPLOAD_BYTES,
  type SaveSourceRequest,
  type ServiceSource,
  type SourceSettings,
  type UploadSourceQuery,
} from "@opsifier/contract";
import type { AppDeps } from "../../../core/context";
import { AppError, badRequest } from "../../../core/errors";
import { ToolNotFoundError } from "../../../core/tools";
import { deleteRepositoryHook } from "../../github/hooks";
import { isGithubConfigured } from "../../github/service";
import { type ServiceRecord, saveServiceSpec } from "../../services/repo";
import { requireService, type ServiceTarget } from "../../services/service";
import { REGISTRY_PASSWORD_CONTEXT } from "../../services/spec";
import { inspectArchive, UnsafeArchiveError } from "./build/archive";
import { probeRemote } from "./build/git";
import { gitRemoteOf, uploadedArchive } from "./build/pipeline";
import { generateSshKeyPair } from "./build/ssh-key";
import { toPublicSource } from "./public";
import {
  SSH_KEY_CONTEXT,
  type StoredBuildState,
  type StoredGithubSource,
  type StoredGitSource,
  type StoredImageSource,
  type StoredSource,
  type StoredUploadSource,
} from "./stored";

export function getSourceSettings(deps: AppDeps, target: ServiceTarget): SourceSettings {
  const { source, build } = requireService(deps, target).spec;
  return {
    source: source === null ? null : toPublicSource(source),
    build: build.config,
    sshPublicKey: build.sshKey?.publicKey ?? null,
    githubConfigured: isGithubConfigured(deps),
  };
}

const invalid = (fields: Record<string, string>) =>
  badRequest("validation_failed", "Some fields need attention.", fields);

type ImageRequest = Extract<SaveSourceRequest, { image: string }>;

/** Works out what to store: a new password, the one already sealed, or none at all. */
function resolveCredentials(
  deps: AppDeps,
  previous: StoredSource | null,
  request: ImageRequest,
): Pick<StoredImageSource, "username" | "sealedPassword"> {
  const username = request.username === undefined || request.username === "" ? null : request.username;
  const password = request.password === undefined || request.password === "" ? null : request.password;

  if (username === null) {
    if (password !== null) {
      throw invalid({ username: "Required with a password" });
    }
    return { username: null, sealedPassword: null };
  }
  if (password !== null) {
    return { username, sealedPassword: deps.secrets.seal(password, REGISTRY_PASSWORD_CONTEXT) };
  }
  if (previous?.type !== "image" || previous.sealedPassword === null) {
    throw invalid({ password: "Required with a username" });
  }
  return { username, sealedPassword: previous.sealedPassword };
}

/** Git's own explanation goes in as `reason`, so a person can see what to fix. */
async function assertReachable(
  deps: AppDeps,
  target: ServiceTarget,
  source: StoredGithubSource | StoredGitSource,
  build: StoredBuildState,
): Promise<void> {
  let result: Awaited<ReturnType<typeof probeRemote>>;
  try {
    result = await probeRemote(deps, gitRemoteOf(deps, target, source, build), source.ref);
  } catch (error) {
    if (error instanceof ToolNotFoundError) {
      throw new AppError(503, "git_unavailable", "git is not installed on this server.");
    }
    throw error;
  }
  if (result.ok) {
    return;
  }
  if (result.reason === "ref-missing") {
    throw badRequest("ref_not_found", "This repository has no branch, tag or commit with that name.", {
      ref: "No branch, tag or commit with this name",
    });
  }
  throw badRequest(
    "repository_unreachable",
    "Opsifier could not read this repository. Check the address and its access rights.",
    result.detail === "" ? undefined : { reason: result.detail },
  );
}

function persist(
  deps: AppDeps,
  target: ServiceTarget,
  update: (record: ServiceRecord) => { source?: StoredSource | null; build?: StoredBuildState },
): StoredBuildState {
  // Read again: the work before this may have taken seconds, and nothing else's edit may be lost.
  const record = requireService(deps, target);
  const change = update(record);
  const spec = {
    ...record.spec,
    ...(change.source === undefined ? {} : { source: change.source }),
    ...(change.build === undefined ? {} : { build: change.build }),
  };
  saveServiceSpec(deps.db, target.projectName, target.serviceName, spec, new Date(deps.now()));
  return spec.build;
}

function recordSourceChange(deps: AppDeps, target: ServiceTarget, actorEmail: string | undefined): void {
  deps.actions.record({
    type: "service.source",
    title: `Update the source of ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
}

/** The last thing a push webhook should do is point at a service that no longer builds from it. */
async function dropStaleHook(
  deps: AppDeps,
  previous: StoredSource | null,
  next: StoredSource,
): Promise<void> {
  if (previous?.type !== "github" || previous.webhookId === null) {
    return;
  }
  if (next.type === "github" && next.repository === previous.repository) {
    return;
  }
  await deleteRepositoryHook(deps, previous.repository, previous.webhookId);
}

/**
 * Saves a source. Nothing is deployed. A Git source is checked first, so a typo is caught here and
 * not at the next deploy, and the check uses the credentials the build will have.
 */
export async function saveServiceSource(
  deps: AppDeps,
  target: ServiceTarget,
  request: SaveSourceRequest,
  actorEmail: string | undefined,
): Promise<ServiceSource> {
  const record = requireService(deps, target);
  const previous = record.spec.source;
  let source: StoredSource;

  switch (request.type) {
    case "github": {
      source = {
        type: "github",
        repository: request.repository,
        ref: request.ref,
        path: request.path,
        webhookId:
          previous?.type === "github" && previous.repository === request.repository
            ? previous.webhookId
            : null,
      };
      await assertReachable(deps, target, source, record.spec.build);
      break;
    }
    case "git": {
      source = { type: "git", url: request.url, ref: request.ref, path: request.path };
      await assertReachable(deps, target, source, record.spec.build);
      break;
    }
    case "dockerfile":
      source = { type: "dockerfile", dockerfile: request.dockerfile };
      break;
    case "upload": {
      if (previous?.type !== "upload") {
        throw badRequest("upload_required", "Upload an archive first.");
      }
      source = { ...previous, path: request.path };
      break;
    }
    default:
      source = { type: "image", image: request.image, ...resolveCredentials(deps, previous, request) };
  }

  await dropStaleHook(deps, previous, source);
  const build = "build" in request ? request.build : undefined;
  persist(deps, target, (current) => ({
    source,
    ...(build === undefined ? {} : { build: { ...current.spec.build, config: build } }),
  }));
  recordSourceChange(deps, target, actorEmail);
  return toPublicSource(source);
}

/** Null goes back to detection. Only sources built from code have build settings at all. */
export function saveBuildSettings(
  deps: AppDeps,
  target: ServiceTarget,
  config: BuildConfig | null,
  actorEmail: string | undefined,
): BuildConfig | null {
  const { source } = requireService(deps, target).spec;
  if (source === null || !isBuildableSourceType(source.type)) {
    throw badRequest("source_not_buildable", "This kind of source has no build settings.");
  }
  persist(deps, target, (current) => ({ build: { ...current.spec.build, config } }));
  recordSourceChange(deps, target, actorEmail);
  return config;
}

/** Makes a new deploy key. Replacing one invalidates the old, and everything else stays as it was. */
export function generateDeployKey(deps: AppDeps, target: ServiceTarget): string {
  const pair = generateSshKeyPair(`opsifier-${target.projectName}-${target.serviceName}`);
  const sealedPrivateKey = deps.secrets.seal(pair.privateKey, SSH_KEY_CONTEXT);
  persist(deps, target, (current) => ({
    build: { ...current.spec.build, sshKey: { sealedPrivateKey, publicKey: pair.publicKey } },
  }));
  return pair.publicKey;
}

export function getEnvFile(deps: AppDeps, target: ServiceTarget): EnvFileSettings {
  return { path: requireService(deps, target).spec.build.envFilePath };
}

export function saveEnvFile(
  deps: AppDeps,
  target: ServiceTarget,
  settings: EnvFileSettings,
  actorEmail: string | undefined,
): EnvFileSettings {
  const { source } = requireService(deps, target).spec;
  if (settings.path !== null && (source === null || source.type === "image")) {
    throw badRequest("source_not_buildable", "A Docker image has no source tree to write to.");
  }
  persist(deps, target, (current) => ({ build: { ...current.spec.build, envFilePath: settings.path } }));
  deps.actions.record({
    type: "service.env",
    title: `Update the environment of ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
  return settings;
}

class UploadTooLargeError extends Error {}

function uploadTooLarge(): AppError {
  return new AppError(413, "upload_too_large", "This archive is larger than the panel accepts.");
}

/**
 * Stores an uploaded archive. The body is counted on the way to the disk, so a client that lies about
 * its size is cut off at the limit, and the file only takes over once it is complete and readable.
 */
export async function receiveUpload(
  deps: AppDeps,
  target: ServiceTarget,
  query: UploadSourceQuery,
  body: ReadableStream<Uint8Array> | null,
  declaredBytes: number | undefined,
  actorEmail: string | undefined,
  maxBytes: number = MAX_UPLOAD_BYTES,
): Promise<ServiceSource> {
  const record = requireService(deps, target);
  if (declaredBytes !== undefined && declaredBytes > maxBytes) {
    throw uploadTooLarge();
  }
  if (body === null) {
    throw badRequest("upload_empty", "The upload was empty.");
  }

  const file = uploadedArchive(deps, target);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const incoming = `${file}.${randomBytes(8).toString("hex")}.incoming`;
  let written = 0;

  try {
    await pipeline(
      Readable.fromWeb(body as WebReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          written += chunk.length;
          done(written > maxBytes ? new UploadTooLargeError() : null, chunk);
        },
      }),
      createWriteStream(incoming, { mode: 0o600, flags: "wx" }),
    );
    if (written === 0) {
      throw badRequest("upload_empty", "The upload was empty.");
    }
    try {
      await inspectArchive(deps, incoming);
    } catch (error) {
      if (error instanceof UnsafeArchiveError) {
        throw badRequest("upload_rejected", error.message);
      }
      if (error instanceof ToolNotFoundError) {
        throw new AppError(503, "archive_tool_unavailable", "bsdtar is not installed on this server.");
      }
      throw error;
    }
    await rename(incoming, file);
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      throw uploadTooLarge();
    }
    throw error;
  } finally {
    await rm(incoming, { force: true });
  }

  const source: StoredUploadSource = {
    type: "upload",
    fileName: basename(query.fileName.replaceAll("\\", "/")),
    sizeBytes: written,
    uploadedAt: new Date(deps.now()).toISOString(),
    path: query.path,
  };
  await dropStaleHook(deps, record.spec.source, source);
  persist(deps, target, () => ({ source }));
  recordSourceChange(deps, target, actorEmail);
  return toPublicSource(source);
}
