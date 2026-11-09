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
  isSshRemote,
  MAX_UPLOAD_BYTES,
  type SaveEnvFileRequest,
  type SaveSourceRequest,
  type ServiceSource,
  type SourceSettings,
  type SshKeyTestResult,
  type UploadSourceQuery,
} from "@opsifier/contract";
import type { AppDeps } from "../../../core/context";
import { AppError, badRequest, conflict, notFound } from "../../../core/errors";
import { ToolNotFoundError } from "../../../core/tools";
import { deleteRepositoryHook } from "../../github/hooks";
import { isGithubConfigured } from "../../github/service";
import { isHostKnown } from "../../known-hosts/service";
import { type RetiredValue, SECRET_VALUE, sealRetired } from "../../services/env-store";
import { type ServiceRecord, saveServiceSpec } from "../../services/repo";
import { requireService, type ServiceTarget } from "../../services/service";
import { REGISTRY_PASSWORD_CONTEXT } from "../../services/spec";
import { inspectArchive, UnsafeArchiveError } from "./build/archive";
import { type GitFailureKind, type ProbeResult, probeRemote } from "./build/git";
import { gitRemoteOf, uploadedArchive } from "./build/pipeline";
import { generateSshKeyPair, sshFingerprint } from "./build/ssh-key";
import { gitSourceOf, imageRepositoryOf, repositoryKey, sourceIdentity, sshHostOf } from "./identity";
import { claimDeployKey } from "./key-binding";
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
    sshKey:
      build.sshKey === null
        ? null
        : {
            fingerprint: sshFingerprint(build.sshKey.publicKey),
            boundTo: build.sshKey.boundTo,
            createdAt: build.sshKey.createdAt,
          },
    githubConfigured: isGithubConfigured(deps),
  };
}

const invalid = (fields: Record<string, string>) =>
  badRequest("validation_failed", "Some fields need attention.", fields);

type ImageRequest = Extract<SaveSourceRequest, { image: string }>;

/**
 * Works out what to store: a new password, the one already sealed, or none at all. A sealed password
 * was given for one image repository, so it does not follow the source to another.
 */
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
  if (imageRepositoryOf(previous.image) !== imageRepositoryOf(request.image)) {
    throw invalid({ password: "Enter the password for this repository again" });
  }
  return { username, sealedPassword: previous.sealedPassword };
}

/**
 * What an SSH address needs before anything is sent to it: a server the registry knows, and a deploy
 * key free for this repository. Returns the build state with the key tied to it, the first time.
 */
export function prepareSshAccess(
  deps: Pick<AppDeps, "db">,
  url: string,
  build: StoredBuildState,
): StoredBuildState {
  if (!isSshRemote(url)) {
    return build;
  }
  const { host, port } = sshHostOf(url);
  if (!isHostKnown(deps, host, port)) {
    throw badRequest(
      "ssh_host_unknown",
      `Opsifier does not know the identity of ${host}. An administrator can add it under Settings, Known hosts.`,
      { url: "This server's identity is not on the list of known hosts" },
    );
  }
  const key = build.sshKey;
  if (key === null) {
    return build;
  }
  const repository = repositoryKey(url);
  if (key.boundTo !== null && key.boundTo !== repository) {
    throw badRequest(
      "ssh_key_bound",
      `This service's deploy key is tied to ${key.boundTo}. Delete it and generate a new one to use another repository.`,
      { url: "The deploy key is tied to another repository" },
    );
  }
  return { ...build, sshKey: { ...key, boundTo: repository } };
}

/** The binding decided a moment ago, on whichever key is current by now. */
export function withKeyBinding(build: StoredBuildState, bound: StoredBuildState["sshKey"]): StoredBuildState {
  if (build.sshKey === null || bound === null || build.sshKey.boundTo !== null) {
    return build;
  }
  return { ...build, sshKey: { ...build.sshKey, boundTo: bound.boundTo } };
}

const PROBE_REFUSALS: Record<Exclude<GitFailureKind, "ref-missing">, { code: string; message: string }> = {
  access: {
    code: "repository_access_denied",
    message:
      "This repository refused access, or isn't at that address. Check the address, and that the deploy key or GitHub token can read it, then save again.",
  },
  network: {
    code: "repository_unreachable",
    message: "This repository could not be reached. Check that this server can reach it, then save again.",
  },
  size: {
    code: "repository_too_large",
    message: "This repository is too large to fetch. Remove large files from it, then save again.",
  },
  unreachable: {
    code: "repository_unreachable",
    message: "Opsifier could not read this repository. Check the address and its access rights.",
  },
};

/** What a failed probe answers. Git's own explanation goes in as `reason`, so a person can see what to fix. */
export function probeRefusal(result: Extract<ProbeResult, { ok: false }>): AppError {
  if (result.reason === "ref-missing") {
    return badRequest(
      "ref_not_found",
      "This repository has no branch, tag or commit with that name. Choose one that exists, then save again.",
      {
        ref: "No branch, tag or commit with this name",
      },
    );
  }
  const refusal = PROBE_REFUSALS[result.reason];
  return badRequest(
    refusal.code,
    refusal.message,
    result.detail === "" ? undefined : { reason: result.detail },
  );
}

/** Checks a source can be read before it is saved, in the same words it would be refused later on. */
async function assertReachable(
  deps: AppDeps,
  source: StoredGithubSource | StoredGitSource,
  build: StoredBuildState,
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

/** A registry password or a deploy key that is being replaced goes on being hidden from output. */
function replacedCredentials(
  deps: AppDeps,
  record: ServiceRecord,
  change: { source?: StoredSource | null; build?: StoredBuildState },
): RetiredValue[] {
  const gone: RetiredValue[] = [];
  const before = record.spec.source;
  const after = change.source === undefined ? before : change.source;
  if (
    before?.type === "image" &&
    before.sealedPassword !== null &&
    (after?.type !== "image" || after.sealedPassword !== before.sealedPassword)
  ) {
    gone.push({
      name: SECRET_VALUE,
      value: deps.secrets.unseal(before.sealedPassword, REGISTRY_PASSWORD_CONTEXT),
    });
  }
  const key = record.spec.build.sshKey;
  const nextKey = change.build === undefined ? key : change.build.sshKey;
  if (key !== null && nextKey?.sealedPrivateKey !== key.sealedPrivateKey) {
    gone.push({ name: SECRET_VALUE, value: deps.secrets.unseal(key.sealedPrivateKey, SSH_KEY_CONTEXT) });
  }
  return gone;
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
    sealedRetired: sealRetired(deps, record.spec.sealedRetired, replacedCredentials(deps, record, change)),
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

/**
 * What a change of source does to what was issued for the old one. The token stops working and the
 * webhook stops being accepted, so whatever held them for the old repository has to be given a new
 * one. Before a first source there is nothing to withdraw from.
 */
export function withdrawAuthority(
  build: StoredBuildState,
  before: string | null,
  after: string | null,
  hookRemoved: boolean,
): { build: StoredBuildState; withdrawn: boolean } {
  if (before === null || before === after) {
    return { build, withdrawn: false };
  }
  const withdrawn = build.deployToken !== null || build.webhook !== null;
  return {
    build: {
      ...build,
      deployToken: null,
      webhook: build.webhook === null || hookRemoved ? null : { ...build.webhook, paused: true },
    },
    withdrawn,
  };
}

export function recordWithdrawal(deps: AppDeps, target: ServiceTarget, actorEmail: string | undefined): void {
  deps.actions.record({
    type: "service.trigger",
    title: `Revoke the deployment token and pause the webhook of ${target.projectName}/${target.serviceName}: its source changed`,
    ...target,
    actorEmail,
  });
}

/** The last thing a push webhook should do is point at a service that no longer builds from it. */
async function dropStaleHook(
  deps: AppDeps,
  previous: StoredSource | null,
  next: StoredSource,
): Promise<boolean> {
  if (previous?.type !== "github" || previous.webhookId === null) {
    return false;
  }
  if (next.type === "github" && next.repository === previous.repository) {
    return false;
  }
  await deleteRepositoryHook(deps, previous.repository, previous.webhookId);
  return true;
}

/** A box's source is generated from its modules, so anything saved here would be overwritten. */
function assertNotBox(record: ServiceRecord): void {
  if (record.spec.box !== null) {
    throw conflict("box_source_managed", "A box builds from its modules. Change them on its Modules tab.");
  }
}

export interface SourceAuthor {
  actorEmail: string | undefined;
  /** Only an administrator can point the panel's own GitHub token at a repository. */
  isAdmin: boolean;
}

/**
 * Saves a source. Nothing is deployed. A Git source is checked first, so a typo is caught here and
 * not at the next deploy, and the check uses the credentials the build will have.
 */
export async function saveServiceSource(
  deps: AppDeps,
  target: ServiceTarget,
  request: SaveSourceRequest,
  author: SourceAuthor,
): Promise<ServiceSource> {
  const { actorEmail } = author;
  const record = requireService(deps, target);
  if (record.spec.database !== null) {
    throw conflict(
      "database_image_managed",
      "A database's image is changed from its Advanced tab, where a new version is checked first.",
    );
  }
  assertNotBox(record);
  const previous = record.spec.source;
  let source: StoredSource;
  let keyed = record.spec.build;

  switch (request.type) {
    case "github": {
      const unchanged =
        previous?.type === "github" &&
        previous.tokenRepository?.toLowerCase() === request.repository.toLowerCase();
      source = {
        type: "github",
        repository: request.repository,
        ref: request.ref,
        path: request.path,
        webhookId:
          previous?.type === "github" && previous.repository === request.repository
            ? previous.webhookId
            : null,
        tokenRepository: author.isAdmin || unchanged ? request.repository : null,
      };
      await assertReachable(deps, source, keyed);
      break;
    }
    case "git": {
      source = { type: "git", url: request.url, ref: request.ref, path: request.path };
      keyed = prepareSshAccess(deps, request.url, keyed);
      await assertReachable(deps, source, keyed);
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

  const hookRemoved = await dropStaleHook(deps, previous, source);
  const build = "build" in request ? request.build : undefined;
  let withdrawn = false;
  persist(deps, target, (current) => {
    const settled = withdrawAuthority(
      withKeyBinding(
        { ...current.spec.build, ...(build === undefined ? {} : { config: build }) },
        keyed.sshKey,
      ),
      sourceIdentity(current.spec),
      sourceIdentity({ source, compose: null }),
      hookRemoved,
    );
    withdrawn = settled.withdrawn;
    return { source, build: settled.build };
  });
  recordSourceChange(deps, target, actorEmail);
  if (withdrawn) {
    recordWithdrawal(deps, target, actorEmail);
  }
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

/**
 * Makes a new deploy key. Replacing one invalidates the old, and it stays tied to the same repository.
 * A first key is tied to nothing yet: the repository it is first used for claims it.
 */
export function generateDeployKey(deps: AppDeps, target: ServiceTarget): string {
  const pair = generateSshKeyPair(`opsifier-${target.projectName}-${target.serviceName}`);
  const sealedPrivateKey = deps.secrets.seal(pair.privateKey, SSH_KEY_CONTEXT);
  const createdAt = new Date(deps.now()).toISOString();
  persist(deps, target, (current) => ({
    build: {
      ...current.spec.build,
      sshKey: {
        sealedPrivateKey,
        publicKey: pair.publicKey,
        boundTo: current.spec.build.sshKey?.boundTo ?? null,
        createdAt,
      },
    },
  }));
  return pair.publicKey;
}

/**
 * Forgets the key, so that nothing here can use it again. The copy of its public half at the Git host
 * is out of reach, so that part of revoking it is up to whoever installed it.
 */
export function deleteDeployKey(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): SourceSettings {
  if (requireService(deps, target).spec.build.sshKey === null) {
    throw notFound("This service has no deploy key.");
  }
  persist(deps, target, (current) => ({ build: { ...current.spec.build, sshKey: null } }));
  deps.actions.record({
    type: "service.source",
    title: `Delete the deploy key of ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
  return getSourceSettings(deps, target);
}

/** Connects to the exact repository the source names, with the key a build would use. */
export async function testDeployKey(deps: AppDeps, target: ServiceTarget): Promise<SshKeyTestResult> {
  const { spec } = requireService(deps, target);
  const git = gitSourceOf(spec);
  if (git === null || git.github || !isSshRemote(git.display)) {
    throw badRequest("source_not_ssh", "Save an SSH repository address first.");
  }
  try {
    claimDeployKey(deps, target, git.display);
    const remote = gitRemoteOf(deps, { type: "git", url: git.display, ref: git.ref, path: "/" }, spec.build);
    const result = await probeRemote(deps, remote, git.ref);
    return result.ok ? { ok: true, detail: "" } : { ok: false, detail: result.detail };
  } catch (error) {
    if (error instanceof ToolNotFoundError) {
      throw new AppError(503, "git_unavailable", "git is not installed on this server.");
    }
    throw error;
  }
}

export function getEnvFile(deps: AppDeps, target: ServiceTarget): EnvFileSettings {
  const { envFilePath, envFileInImage } = requireService(deps, target).spec.build;
  return { path: envFilePath, inImage: envFileInImage };
}

export function saveEnvFile(
  deps: AppDeps,
  target: ServiceTarget,
  settings: SaveEnvFileRequest,
  actorEmail: string | undefined,
): EnvFileSettings {
  const { source } = requireService(deps, target).spec;
  if (settings.path !== null && (source === null || source.type === "image")) {
    throw badRequest("source_not_buildable", "A Docker image has no source tree to write to.");
  }
  // Having no file decides nothing, so the next one is asked again.
  const inImage = settings.path !== null && settings.inImage === true;
  persist(deps, target, (current) => ({
    build: { ...current.spec.build, envFilePath: settings.path, envFileInImage: inImage },
  }));
  deps.actions.record({
    type: "service.env",
    title: `Update the environment of ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
  return { path: settings.path, inImage };
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
  assertNotBox(record);
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
  const hookRemoved = await dropStaleHook(deps, record.spec.source, source);
  let withdrawn = false;
  persist(deps, target, (current) => {
    const settled = withdrawAuthority(
      current.spec.build,
      sourceIdentity(current.spec),
      sourceIdentity({ source, compose: null }),
      hookRemoved,
    );
    withdrawn = settled.withdrawn;
    return { source, build: settled.build };
  });
  recordSourceChange(deps, target, actorEmail);
  if (withdrawn) {
    recordWithdrawal(deps, target, actorEmail);
  }
  return toPublicSource(source);
}
