import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  type CheckStorageProviderResponse,
  type CreateStorageProviderFields,
  isOAuthKind,
  isS3Kind,
  type OAuthProviderKind,
  requiredPermissions,
  type S3ProviderKind,
  type StorageProviderConfig,
  type StorageProviderEntry,
  type StorageProviderKind,
  type StorageProviderList,
  type StorageProviderOptions,
  storageErrorCodes,
  storageProviderActionTypes,
  type UpdateStorageProviderFields,
} from "@opsifier/contract";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { AppDeps } from "../../core/context";
import { type AppError, badRequest, conflict, notFound } from "../../core/errors";
import { Redactor } from "../../core/tools";
import { DROPBOX_ENDPOINTS, DropboxBackend, type DropboxEndpoints } from "./backends/dropbox";
import { FtpBackend } from "./backends/ftp";
import {
  GOOGLE_DRIVE_ENDPOINTS,
  GoogleDriveBackend,
  type GoogleDriveEndpoints,
} from "./backends/google-drive";
import { LocalBackend } from "./backends/local";
import { OAuthSession, type OAuthTokenStore, type OAuthTokens } from "./backends/oauth";
import { defaultEndpoint, S3Backend } from "./backends/s3";
import { SftpBackend } from "./backends/sftp";
import { type StorageBackend, StorageError } from "./backends/types";
import {
  deleteProviderRow,
  detachConfigsFromProvider,
  findProviderRow,
  findProviderRowByName,
  insertProviderRow,
  listProviderRows,
  type ProviderRow,
  providerUsageCounts,
  updateProviderRow,
} from "./repo";

export const BUILT_IN_PROVIDER_ID = "local-disk";
const BUILT_IN_PROVIDER_NAME = "Local Disk";

const storedLocal = z.object({ path: z.string() });
const storedSftp = z.object({
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  rootPath: z.string(),
  hostKey: z.string().nullable().default(null),
});
const storedFtp = z.object({
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  rootPath: z.string(),
  tls: z.boolean().default(false),
});
const storedS3 = z.object({
  accessKeyId: z.string(),
  bucket: z.string(),
  region: z.string(),
  endpoint: z.string().nullable(),
  storageClass: z.string().nullable(),
  prefix: z.string(),
});
const storedOAuth = z.object({ clientId: z.string(), account: z.string().nullable().default(null) });

type StoredConfig =
  | z.infer<typeof storedLocal>
  | z.infer<typeof storedSftp>
  | z.infer<typeof storedFtp>
  | z.infer<typeof storedS3>
  | z.infer<typeof storedOAuth>;

const sealedSecrets = z.object({
  password: z.string().optional(),
  secretAccessKey: z.string().optional(),
  clientSecret: z.string().optional(),
  tokens: z
    .object({ accessToken: z.string(), refreshToken: z.string(), expiresAt: z.number() })
    .nullable()
    .optional(),
});
type ProviderSecrets = z.infer<typeof sealedSecrets>;

const SECRETS_CONTEXT = "storage-provider";

function sealSecrets(deps: Pick<AppDeps, "secrets">, id: string, secrets: ProviderSecrets): string {
  return deps.secrets.seal(JSON.stringify(secrets), `${SECRETS_CONTEXT}:${id}`);
}

function readSecrets(deps: Pick<AppDeps, "secrets">, row: ProviderRow): ProviderSecrets {
  if (row.sealedSecrets === null) {
    return {};
  }
  return sealedSecrets.parse(
    JSON.parse(deps.secrets.unseal(row.sealedSecrets, `${SECRETS_CONTEXT}:${row.id}`)),
  );
}

function secretLiterals(secrets: ProviderSecrets): string[] {
  return [secrets.password, secrets.secretAccessKey, secrets.clientSecret]
    .concat(
      secrets.tokens === null || secrets.tokens === undefined
        ? []
        : [secrets.tokens.accessToken, secrets.tokens.refreshToken],
    )
    .filter((value): value is string => value !== undefined && value !== "");
}

function redactorFor(deps: Pick<AppDeps, "secrets">, row: ProviderRow): Redactor {
  const redactor = new Redactor();
  for (const literal of secretLiterals(readSecrets(deps, row))) {
    redactor.add(literal);
  }
  return redactor;
}

/** The message a person may see for a failure talking to a destination. */
export function safeStorageMessage(deps: Pick<AppDeps, "secrets">, row: ProviderRow, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactorFor(deps, row).apply(message);
}

interface OAuthKindEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  scope: string;
  dropbox?: DropboxEndpoints;
  drive?: GoogleDriveEndpoints;
}

const defaultOAuthEndpoints: Record<OAuthProviderKind, OAuthKindEndpoints> = {
  dropbox: {
    authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    revokeUrl: "https://api.dropboxapi.com/2/auth/token/revoke",
    scope: "account_info.read files.content.write files.content.read files.metadata.read",
    dropbox: DROPBOX_ENDPOINTS,
  },
  "google-drive": {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    scope: "https://www.googleapis.com/auth/drive.file",
    drive: GOOGLE_DRIVE_ENDPOINTS,
  },
};

let oauthEndpoints = defaultOAuthEndpoints;

/** Points the OAuth providers somewhere else, so that tests can run them against a stub. */
export function overrideOAuthEndpoints(
  overrides: Partial<Record<OAuthProviderKind, Partial<OAuthKindEndpoints>>> | null,
): void {
  oauthEndpoints =
    overrides === null
      ? defaultOAuthEndpoints
      : {
          dropbox: { ...defaultOAuthEndpoints.dropbox, ...overrides.dropbox },
          "google-drive": { ...defaultOAuthEndpoints["google-drive"], ...overrides["google-drive"] },
        };
}

/** Tokens live sealed in the provider's row, so a refresh is saved the moment it happens. */
function tokenStoreFor(deps: AppDeps, id: string): OAuthTokenStore {
  return {
    load() {
      const row = findProviderRow(deps.db, id);
      return row === undefined ? null : (readSecrets(deps, row).tokens ?? null);
    },
    save(tokens) {
      const row = findProviderRow(deps.db, id);
      if (row !== undefined) {
        updateProviderRow(deps.db, id, {
          sealedSecrets: sealSecrets(deps, id, { ...readSecrets(deps, row), tokens }),
        });
      }
    },
    revoked(reason) {
      const row = findProviderRow(deps.db, id);
      if (row !== undefined) {
        updateProviderRow(deps.db, id, {
          sealedSecrets: sealSecrets(deps, id, { ...readSecrets(deps, row), tokens: null }),
          connected: false,
          lastCheckAt: new Date(deps.now()),
          lastCheckError: reason,
        });
      }
    },
  };
}

function oauthSessionFor(deps: AppDeps, row: ProviderRow): OAuthSession {
  const kind = row.kind as OAuthProviderKind;
  const config = storedOAuth.parse(row.config);
  return new OAuthSession({
    store: tokenStoreFor(deps, row.id),
    tokenUrl: oauthEndpoints[kind].tokenUrl,
    clientId: config.clientId,
    clientSecret: readSecrets(deps, row).clientSecret ?? "",
    now: deps.now,
  });
}

/** Everything the rest of the panel needs to reach a destination. */
export function backendForProvider(deps: AppDeps, row: ProviderRow): StorageBackend {
  const kind = row.kind as StorageProviderKind;
  const secrets = readSecrets(deps, row);
  if (kind === "local") {
    return new LocalBackend(storedLocal.parse(row.config).path);
  }
  if (kind === "sftp") {
    const config = storedSftp.parse(row.config);
    return new SftpBackend({
      ...config,
      password: secrets.password ?? "",
      onHostKey: (hostKey) => {
        updateProviderRow(deps.db, row.id, { config: { ...config, hostKey } });
      },
    });
  }
  if (kind === "ftp") {
    return new FtpBackend({ ...storedFtp.parse(row.config), password: secrets.password ?? "" });
  }
  if (isS3Kind(kind)) {
    return new S3Backend({
      kind,
      ...storedS3.parse(row.config),
      secretAccessKey: secrets.secretAccessKey ?? "",
    });
  }
  if (kind === "dropbox") {
    return new DropboxBackend(oauthSessionFor(deps, row), oauthEndpoints.dropbox.dropbox);
  }
  return new GoogleDriveBackend(oauthSessionFor(deps, row), oauthEndpoints["google-drive"].drive);
}

/** Where restic keeps a repository on a destination, and what it needs to reach it. */
export interface ResticTarget {
  repository: string;
  env: Record<string, string>;
  /** Values to keep out of every log. */
  secrets: string[];
}

/**
 * A destination as restic reaches it, for the server's own backup. S3-compatible destinations and
 * the server's disk for now; null for the others, which restic would reach through rclone.
 */
export function resticTargetFor(deps: AppDeps, row: ProviderRow, folder: string): ResticTarget | null {
  const kind = row.kind as StorageProviderKind;
  if (kind === "local") {
    return { repository: join(storedLocal.parse(row.config).path, folder), env: {}, secrets: [] };
  }
  if (!isS3Kind(kind)) {
    return null;
  }
  const config = storedS3.parse(row.config);
  const endpoint = config.endpoint ?? defaultEndpoint(kind, config.region);
  if (endpoint === null) {
    return null;
  }
  const secret = readSecrets(deps, row).secretAccessKey ?? "";
  const path = [config.bucket, config.prefix, folder]
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter((part) => part !== "")
    .join("/");
  return {
    repository: `s3:${endpoint.replace(/\/+$/, "")}/${path}`,
    env: {
      AWS_ACCESS_KEY_ID: config.accessKeyId,
      AWS_SECRET_ACCESS_KEY: secret,
      AWS_DEFAULT_REGION: config.region,
    },
    secrets: [secret],
  };
}

export function toStorageError(error: unknown): StorageError {
  if (error instanceof StorageError) {
    return error;
  }
  return new StorageError("failed", error instanceof Error ? error.message : String(error));
}

const API_CODES: Record<StorageError["kind"], string> = {
  unreachable: storageErrorCodes.unreachable,
  denied: storageErrorCodes.denied,
  host_key: storageErrorCodes.hostKeyChanged,
  disconnected: storageErrorCodes.notConnected,
  not_found: "storage_not_found",
  failed: "storage_failed",
};

function toApiError(deps: AppDeps, row: ProviderRow, error: unknown): AppError {
  const storage = toStorageError(error);
  return badRequest(API_CODES[storage.kind], safeStorageMessage(deps, row, storage));
}

function publicConfig(row: ProviderRow): StorageProviderConfig {
  const kind = row.kind as StorageProviderKind;
  if (kind === "local") {
    return { kind, ...storedLocal.parse(row.config) };
  }
  if (kind === "sftp") {
    return { kind, ...storedSftp.parse(row.config) };
  }
  if (kind === "ftp") {
    return { kind, ...storedFtp.parse(row.config) };
  }
  if (isS3Kind(kind)) {
    return { kind, ...storedS3.parse(row.config) };
  }
  return { kind, ...storedOAuth.parse(row.config) };
}

function locationOf(row: ProviderRow): string {
  const config = publicConfig(row);
  switch (config.kind) {
    case "local":
      return config.path;
    case "sftp":
      return `sftp://${config.username}@${config.host}:${config.port}${config.rootPath === "" ? "" : `/${config.rootPath.replace(/^\//, "")}`}`;
    case "ftp":
      return `${config.tls ? "ftps" : "ftp"}://${config.username}@${config.host}:${config.port}${config.rootPath === "" ? "" : `/${config.rootPath.replace(/^\//, "")}`}`;
    case "dropbox":
    case "google-drive":
      return config.account ?? "";
    default:
      return `s3://${config.bucket}${config.prefix === "" ? "" : `/${config.prefix}`}`;
  }
}

function toEntry(row: ProviderRow, usage: ReadonlyMap<string, number>): StorageProviderEntry {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as StorageProviderKind,
    builtIn: row.builtIn,
    status: row.connected ? "ready" : "disconnected",
    location: locationOf(row),
    offHost: row.kind !== "local",
    usedBy: usage.get(row.id) ?? 0,
    requiredPermissions: [...requiredPermissions[row.kind as StorageProviderKind]],
    lastCheckAt: row.lastCheckAt?.toISOString() ?? null,
    lastCheckError: row.lastCheckError,
    config: publicConfig(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The Local Disk every install has. Its folder belongs to the data directory of this panel. */
export function ensureBuiltInProvider(deps: AppDeps): void {
  const path = join(deps.config.dataDir, "backups");
  const existing = findProviderRow(deps.db, BUILT_IN_PROVIDER_ID);
  const now = new Date(deps.now());
  if (existing === undefined) {
    insertProviderRow(deps.db, {
      id: BUILT_IN_PROVIDER_ID,
      name: BUILT_IN_PROVIDER_NAME,
      kind: "local",
      builtIn: true,
      config: { path },
      connected: true,
      createdAt: now,
      updatedAt: now,
    });
  } else if (storedLocal.parse(existing.config).path !== path) {
    // A data directory that moved takes its backups with it.
    updateProviderRow(deps.db, BUILT_IN_PROVIDER_ID, { config: { path }, updatedAt: now });
  }
}

export function listProviders(deps: AppDeps, redirectOrigin: string): StorageProviderList {
  const usage = providerUsageCounts(deps.db);
  return {
    providers: listProviderRows(deps.db).map((row) => toEntry(row, usage)),
    oauthRedirectUrl: oauthRedirectUrl(redirectOrigin),
  };
}

/** Only the destinations a backup can use right now. */
export function listProviderOptions(deps: AppDeps): StorageProviderOptions {
  return {
    options: listProviderRows(deps.db)
      .filter((row) => row.connected)
      .map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind as StorageProviderKind,
        offHost: row.kind !== "local",
      })),
  };
}

export function requireProvider(deps: Pick<AppDeps, "db">, id: string): ProviderRow {
  const row = findProviderRow(deps.db, id);
  if (row === undefined) {
    throw notFound("This storage provider does not exist.");
  }
  return row;
}

function assertNameFree(deps: Pick<AppDeps, "db">, name: string, exceptId?: string): void {
  const existing = findProviderRowByName(deps.db, name);
  if (existing !== undefined && existing.id !== exceptId) {
    throw conflict("provider_name_taken", "A destination with this name already exists.", {
      name: "This name is taken",
    });
  }
}

/** Folders that can't sensibly hold backups, and the panel's own working folders, are refused. */
function assertLocalPathAllowed(deps: Pick<AppDeps, "config">, path: string): void {
  const { dataDir } = deps.config;
  const within = (parent: string) => path === parent || path.startsWith(`${parent}/`);
  const system = [
    "/bin",
    "/boot",
    "/dev",
    "/etc",
    "/lib",
    "/lib64",
    "/proc",
    "/run",
    "/sbin",
    "/sys",
    "/usr",
  ];
  if (path === "/" || path === "/var" || path === "/home" || path === "/root" || system.some(within)) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      path: "This is a system folder. Pick one that only holds backups",
    });
  }
  const insideData = within(dataDir) && !within(join(dataDir, "backups"));
  if (insideData) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      path: "This folder belongs to the panel itself. Use another one",
    });
  }
}

interface PreparedProvider {
  config: StoredConfig;
  secrets: ProviderSecrets | null;
}

function prepareNew(deps: AppDeps, request: CreateStorageProviderFields): PreparedProvider {
  switch (request.kind) {
    case "local":
      assertLocalPathAllowed(deps, request.path);
      return { config: { path: request.path }, secrets: null };
    case "sftp":
      return {
        config: {
          host: request.host,
          port: request.port,
          username: request.username,
          rootPath: request.rootPath,
          hostKey: null,
        },
        secrets: { password: request.password },
      };
    case "ftp":
      return {
        config: {
          host: request.host,
          port: request.port,
          username: request.username,
          rootPath: request.rootPath,
          tls: request.tls,
        },
        secrets: { password: request.password },
      };
    case "dropbox":
    case "google-drive":
      return {
        config: { clientId: request.clientId, account: null },
        secrets: { clientSecret: request.clientSecret, tokens: null },
      };
    default:
      assertEndpointFits(request.kind, request.endpoint);
      return {
        config: {
          accessKeyId: request.accessKeyId,
          bucket: request.bucket,
          region: request.region,
          endpoint: request.endpoint ?? null,
          storageClass: request.storageClass ?? null,
          prefix: request.prefix,
        },
        secrets: { secretAccessKey: request.secretAccessKey },
      };
  }
}

function assertEndpointFits(kind: S3ProviderKind, endpoint: string | undefined): void {
  if ((kind === "cloudflare-r2" || kind === "generic-s3") && endpoint === undefined) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      endpoint: "This destination needs its endpoint",
    });
  }
}

/** Tries a provider that is not saved yet, so a bad one is rejected and never stored. */
async function verifyCandidate(deps: AppDeps, candidate: ProviderRow): Promise<void> {
  if (isOAuthKind(candidate.kind as StorageProviderKind)) {
    return;
  }
  try {
    await backendForProvider(deps, candidate).check(AbortSignal.timeout(60_000));
  } catch (error) {
    throw toApiError(deps, candidate, error);
  }
}

export async function createProvider(
  deps: AppDeps,
  request: CreateStorageProviderFields,
  actorEmail: string | undefined,
): Promise<StorageProviderEntry> {
  assertNameFree(deps, request.name);
  const id = nanoid();
  const { config, secrets } = prepareNew(deps, request);
  const now = new Date(deps.now());
  const row: ProviderRow = {
    id,
    name: request.name,
    kind: request.kind,
    builtIn: false,
    config,
    sealedSecrets: secrets === null ? null : sealSecrets(deps, id, secrets),
    connected: !isOAuthKind(request.kind),
    lastCheckAt: null,
    lastCheckError: null,
    createdAt: now,
    updatedAt: now,
  };

  // Learns the SFTP server's key during the check, so the row is saved with it.
  const candidateRow = { ...row };
  if (request.kind === "sftp") {
    await verifyCandidateRemembering(deps, candidateRow);
  } else {
    await verifyCandidate(deps, candidateRow);
  }

  const inserted = insertProviderRow(deps.db, { ...candidateRow, lastCheckAt: now, lastCheckError: null });
  deps.actions.record({
    type: storageProviderActionTypes.create,
    title: `Add storage provider ${request.name}`,
    actorEmail,
  });
  return toEntry(inserted, providerUsageCounts(deps.db));
}

/** Runs the check on a row that isn't saved yet, keeping the host key it discovers. */
async function verifyCandidateRemembering(deps: AppDeps, candidate: ProviderRow): Promise<void> {
  const config = storedSftp.parse(candidate.config);
  const secrets = readSecrets(deps, candidate);
  let learned: string | null = config.hostKey;
  const backend = new SftpBackend({
    ...config,
    password: secrets.password ?? "",
    onHostKey: (hostKey) => {
      learned = hostKey;
    },
  });
  try {
    await backend.check(AbortSignal.timeout(60_000));
  } catch (error) {
    throw toApiError(deps, candidate, error);
  }
  candidate.config = { ...config, hostKey: learned };
}

export async function updateProvider(
  deps: AppDeps,
  id: string,
  request: UpdateStorageProviderFields,
  actorEmail: string | undefined,
): Promise<StorageProviderEntry> {
  const row = requireProvider(deps, id);
  if (row.builtIn) {
    throw conflict("built_in_provider", "The built-in Local Disk cannot be changed.");
  }
  if (row.kind !== request.kind) {
    throw badRequest("validation_failed", "A destination's type can't be changed.");
  }
  assertNameFree(deps, request.name, id);

  const secrets = readSecrets(deps, row);
  const now = new Date(deps.now());
  let config = row.config as StoredConfig;
  let nextSecrets: ProviderSecrets | null = row.sealedSecrets === null ? null : secrets;

  switch (request.kind) {
    case "local":
      assertLocalPathAllowed(deps, request.path);
      config = { path: request.path };
      break;
    case "sftp": {
      const current = storedSftp.parse(row.config);
      const sameServer = current.host === request.host && current.port === request.port;
      config = {
        host: request.host,
        port: request.port,
        username: request.username,
        rootPath: request.rootPath,
        hostKey: sameServer && !request.trustNewHostKey ? current.hostKey : null,
      };
      nextSecrets = { ...secrets, password: request.password ?? secrets.password };
      break;
    }
    case "ftp":
      config = {
        host: request.host,
        port: request.port,
        username: request.username,
        rootPath: request.rootPath,
        tls: request.tls,
      };
      nextSecrets = { ...secrets, password: request.password ?? secrets.password };
      break;
    case "dropbox":
    case "google-drive":
      break;
    default:
      assertEndpointFits(request.kind, request.endpoint);
      config = {
        accessKeyId: request.accessKeyId,
        bucket: request.bucket,
        region: request.region,
        endpoint: request.endpoint ?? null,
        storageClass: request.storageClass ?? null,
        prefix: request.prefix,
      };
      nextSecrets = { ...secrets, secretAccessKey: request.secretAccessKey ?? secrets.secretAccessKey };
  }

  const candidate: ProviderRow = {
    ...row,
    name: request.name,
    config,
    sealedSecrets: nextSecrets === null ? null : sealSecrets(deps, id, nextSecrets),
    updatedAt: now,
  };
  if (request.kind === "sftp") {
    await verifyCandidateRemembering(deps, candidate);
  } else {
    await verifyCandidate(deps, candidate);
  }

  const updated = updateProviderRow(deps.db, id, {
    name: candidate.name,
    config: candidate.config,
    sealedSecrets: candidate.sealedSecrets,
    lastCheckAt: now,
    lastCheckError: null,
    updatedAt: now,
  });
  if (updated === undefined) {
    throw notFound("This storage provider does not exist.");
  }
  deps.actions.record({
    type: storageProviderActionTypes.update,
    title: `Update storage provider ${request.name}`,
    actorEmail,
  });
  return toEntry(updated, providerUsageCounts(deps.db));
}

/** Files already stored are left where they are. A destination that no longer works stays deletable. */
export function deleteProvider(deps: AppDeps, id: string, actorEmail: string | undefined): void {
  const row = requireProvider(deps, id);
  if (row.builtIn) {
    throw conflict("built_in_provider", "The built-in Local Disk cannot be removed.");
  }
  const now = new Date(deps.now());
  deps.db.transaction((tx) => {
    detachConfigsFromProvider(tx as unknown as typeof deps.db, [id], now);
    deleteProviderRow(tx, id);
  });
  deps.actions.record({
    type: storageProviderActionTypes.delete,
    title: `Remove storage provider ${row.name}`,
    actorEmail,
  });
}

/** The same check a save runs, for a destination that already exists. The result is kept on the row. */
export async function checkProvider(deps: AppDeps, id: string): Promise<CheckStorageProviderResponse> {
  const row = requireProvider(deps, id);
  const now = new Date(deps.now());
  try {
    await backendForProvider(deps, row).check(AbortSignal.timeout(60_000));
    updateProviderRow(deps.db, id, { lastCheckAt: now, lastCheckError: null });
    return { ok: true, error: null };
  } catch (error) {
    const message = safeStorageMessage(deps, row, toStorageError(error));
    updateProviderRow(deps.db, id, { lastCheckAt: now, lastCheckError: message });
    return { ok: false, error: message };
  }
}

const OAUTH_CALLBACK_PATH = "/api/v1/storage-providers/oauth/callback";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_OAUTH = 256;

export const oauthCallbackPath = OAUTH_CALLBACK_PATH;

export const oauthRedirectUrl = (origin: string): string => `${origin}${OAUTH_CALLBACK_PATH}`;

interface PendingOAuth {
  providerId: string;
  redirectUri: string;
  actorEmail: string | undefined;
  expiresAt: number;
}

const pendingOAuth = new Map<string, PendingOAuth>();

function rememberOAuth(state: string, entry: PendingOAuth, now: number): void {
  for (const [key, value] of pendingOAuth) {
    if (value.expiresAt <= now) {
      pendingOAuth.delete(key);
    }
  }
  while (pendingOAuth.size >= MAX_PENDING_OAUTH) {
    const oldest = pendingOAuth.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    pendingOAuth.delete(oldest);
  }
  pendingOAuth.set(state, entry);
}

/** The address to send the browser to, valid for one attempt within ten minutes. */
export function startOAuth(
  deps: AppDeps,
  id: string,
  origin: string,
  actorEmail: string | undefined,
): { authorizationUrl: string } {
  const row = requireProvider(deps, id);
  const kind = row.kind as StorageProviderKind;
  if (!isOAuthKind(kind)) {
    throw badRequest("not_oauth", "This destination does not sign in through a provider.");
  }
  const state = randomBytes(32).toString("base64url");
  const redirectUri = oauthRedirectUrl(origin);
  rememberOAuth(
    state,
    { providerId: id, redirectUri, actorEmail, expiresAt: deps.now() + OAUTH_STATE_TTL_MS },
    deps.now(),
  );

  const config = storedOAuth.parse(row.config);
  const endpoints = oauthEndpoints[kind];
  const url = new URL(endpoints.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  if (kind === "dropbox") {
    url.searchParams.set("token_access_type", "offline");
    url.searchParams.set("scope", endpoints.scope);
  } else {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("scope", endpoints.scope);
  }
  return { authorizationUrl: url.toString() };
}

async function exchangeCode(
  deps: AppDeps,
  row: ProviderRow,
  code: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  const kind = row.kind as OAuthProviderKind;
  const config = storedOAuth.parse(row.config);
  const response = await fetch(oauthEndpoints[kind].tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      client_secret: readSecrets(deps, row).clientSecret ?? "",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  } | null;
  if (
    !response.ok ||
    body === null ||
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string"
  ) {
    throw new StorageError(
      "denied",
      body?.error === "invalid_grant"
        ? "The provider did not accept this sign-in. Try connecting again."
        : "The provider did not give the panel a long-lived token. Remove its access and connect again.",
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: deps.now() + (body.expires_in ?? 3600) * 1000,
  };
}

export type OAuthOutcome = { ok: true; providerId: string } | { ok: false; reason: string };

/**
 * Finishes the sign-in. The address it came through carries no session, so the state value, single
 * use and unguessable, is what proves this answer belongs to the attempt the panel started.
 */
export async function completeOAuth(
  deps: AppDeps,
  query: { state?: string; code?: string; error?: string },
): Promise<OAuthOutcome> {
  const { state, code } = query;
  if (state === undefined) {
    return { ok: false, reason: "missing_state" };
  }
  const pending = pendingOAuth.get(state);
  pendingOAuth.delete(state);
  if (pending === undefined || pending.expiresAt <= deps.now()) {
    return { ok: false, reason: "invalid_state" };
  }
  if (query.error !== undefined || code === undefined) {
    return { ok: false, reason: "denied" };
  }
  const row = findProviderRow(deps.db, pending.providerId);
  if (row === undefined) {
    return { ok: false, reason: "provider_missing" };
  }

  let tokens: OAuthTokens;
  try {
    tokens = await exchangeCode(deps, row, code, pending.redirectUri);
  } catch (error) {
    deps.logger.warn({ provider: row.id }, safeStorageMessage(deps, row, error));
    return { ok: false, reason: "exchange_failed" };
  }

  const now = new Date(deps.now());
  const config = storedOAuth.parse(row.config);
  updateProviderRow(deps.db, row.id, {
    sealedSecrets: sealSecrets(deps, row.id, { ...readSecrets(deps, row), tokens }),
    connected: true,
    lastCheckAt: now,
    lastCheckError: null,
    updatedAt: now,
  });

  // Who it connected to is a label: failing to read it must not undo the connection.
  const connected = findProviderRow(deps.db, row.id);
  if (connected !== undefined) {
    const account = await accountNameOf(deps, connected).catch(() => null);
    if (account !== null) {
      updateProviderRow(deps.db, row.id, { config: { ...config, account } });
    }
  }
  deps.actions.record({
    type: storageProviderActionTypes.connect,
    title: `Connect storage provider ${row.name}`,
    actorEmail: pending.actorEmail,
  });
  return { ok: true, providerId: row.id };
}

async function accountNameOf(deps: AppDeps, row: ProviderRow): Promise<string> {
  const backend = backendForProvider(deps, row);
  if (backend instanceof DropboxBackend || backend instanceof GoogleDriveBackend) {
    return backend.accountName(AbortSignal.timeout(20_000));
  }
  throw new Error("This provider has no account name.");
}

/** Gives up access, at the provider too. The entry stays so that it can be connected again. */
export async function disconnectProvider(
  deps: AppDeps,
  id: string,
  actorEmail: string | undefined,
): Promise<StorageProviderEntry> {
  const row = requireProvider(deps, id);
  const kind = row.kind as StorageProviderKind;
  if (!isOAuthKind(kind)) {
    throw badRequest("not_oauth", "This destination does not sign in through a provider.");
  }
  const secrets = readSecrets(deps, row);
  const tokens = secrets.tokens ?? null;
  if (tokens !== null) {
    await revokeToken(deps, kind, tokens, row);
  }
  const updated = updateProviderRow(deps.db, id, {
    sealedSecrets: sealSecrets(deps, id, { ...secrets, tokens: null }),
    connected: false,
    updatedAt: new Date(deps.now()),
  });
  if (updated === undefined) {
    throw notFound("This storage provider does not exist.");
  }
  deps.actions.record({
    type: storageProviderActionTypes.disconnect,
    title: `Disconnect storage provider ${row.name}`,
    actorEmail,
  });
  return toEntry(updated, providerUsageCounts(deps.db));
}

/** Best effort: if the token is already dead at the provider, there is nothing left to revoke. */
async function revokeToken(
  deps: AppDeps,
  kind: OAuthProviderKind,
  tokens: OAuthTokens,
  row: ProviderRow,
): Promise<void> {
  const url = oauthEndpoints[kind].revokeUrl;
  const init: RequestInit =
    kind === "dropbox"
      ? {
          method: "POST",
          headers: { authorization: `Bearer ${tokens.accessToken}`, "content-type": "application/json" },
          body: "null",
        }
      : {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: tokens.refreshToken }),
        };
  try {
    await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    deps.logger.warn(
      { provider: row.id },
      `Could not revoke a token: ${safeStorageMessage(deps, row, error)}`,
    );
  }
}
