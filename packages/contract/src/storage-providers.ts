import { z } from "zod";
import { digitsToNumber } from "./common";
import { isCleanAbsolutePath } from "./service-tabs/storage";

/** Every kind of destination a backup can be sent to, in the order the Create menu lists them. */
export const storageProviderKinds = [
  "local",
  "sftp",
  "ftp",
  "dropbox",
  "google-drive",
  "aws-s3",
  "cloudflare-r2",
  "digitalocean-spaces",
  "backblaze-b2",
  "wasabi",
  "generic-s3",
] as const;
export const storageProviderKind = z.enum(storageProviderKinds);
export type StorageProviderKind = z.infer<typeof storageProviderKind>;

export const s3ProviderKinds = [
  "aws-s3",
  "cloudflare-r2",
  "digitalocean-spaces",
  "backblaze-b2",
  "wasabi",
  "generic-s3",
] as const;
export type S3ProviderKind = (typeof s3ProviderKinds)[number];

export const oauthProviderKinds = ["dropbox", "google-drive"] as const;
export type OAuthProviderKind = (typeof oauthProviderKinds)[number];

export const isS3Kind = (kind: StorageProviderKind): kind is S3ProviderKind =>
  (s3ProviderKinds as readonly string[]).includes(kind);

export const isOAuthKind = (kind: StorageProviderKind): kind is OAuthProviderKind =>
  (oauthProviderKinds as readonly string[]).includes(kind);

export interface S3KindInfo {
  regionPlaceholder: string;
  /** Null where the endpoint follows from the region, as on AWS. */
  endpointPlaceholder: string | null;
  endpointRequired: boolean;
  /** Offered as suggestions. Providers differ, and a class the bucket does not support fails at upload. */
  storageClasses: readonly string[];
}

/** What differs between the S3-compatible destinations. Forms and the backend read this one table. */
export const s3KindInfo: Record<S3ProviderKind, S3KindInfo> = {
  "aws-s3": {
    regionPlaceholder: "us-east-1",
    endpointPlaceholder: null,
    endpointRequired: false,
    storageClasses: ["STANDARD", "STANDARD_IA", "ONEZONE_IA", "INTELLIGENT_TIERING", "GLACIER_IR"],
  },
  "cloudflare-r2": {
    regionPlaceholder: "auto",
    endpointPlaceholder: "https://<account-id>.r2.cloudflarestorage.com",
    endpointRequired: true,
    storageClasses: ["STANDARD"],
  },
  "digitalocean-spaces": {
    regionPlaceholder: "nyc3",
    endpointPlaceholder: "https://nyc3.digitaloceanspaces.com",
    endpointRequired: false,
    storageClasses: ["STANDARD"],
  },
  "backblaze-b2": {
    regionPlaceholder: "us-east-005",
    endpointPlaceholder: "https://s3.us-east-005.backblazeb2.com",
    endpointRequired: false,
    storageClasses: ["STANDARD"],
  },
  wasabi: {
    regionPlaceholder: "eu-central-1",
    endpointPlaceholder: "https://s3.eu-central-1.wasabisys.com",
    endpointRequired: false,
    storageClasses: ["STANDARD"],
  },
  "generic-s3": {
    regionPlaceholder: "us-east-1",
    endpointPlaceholder: "https://s3.example.com",
    endpointRequired: true,
    storageClasses: ["STANDARD"],
  },
};

const fileOperations = ["list", "read", "write", "rename", "delete"] as const;

/**
 * What a destination's credentials must be allowed to do. It is what every save is checked against:
 * a backup writes, a restore reads, and retention lists and deletes.
 */
export const requiredPermissions: Record<StorageProviderKind, readonly string[]> = {
  local: fileOperations,
  sftp: fileOperations,
  ftp: fileOperations,
  dropbox: ["account_info.read", "files.content.write", "files.content.read", "files.metadata.read"],
  "google-drive": ["https://www.googleapis.com/auth/drive.file"],
  "aws-s3": ["s3:ListBucket", "s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
  "cloudflare-r2": ["Object Read & Write, on this bucket"],
  "digitalocean-spaces": ["Read and write on this bucket"],
  "backblaze-b2": ["listBuckets", "listFiles", "readFiles", "writeFiles", "deleteFiles"],
  wasabi: ["s3:ListBucket", "s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
  "generic-s3": ["s3:ListBucket", "s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
};

const blank = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const text = (max: number) =>
  z
    .string("Required")
    .trim()
    .min(1, "Required")
    .max(max, "This is too long")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
    .regex(/^[^\u0000-\u001f\u007f]*$/, "Must not contain control characters");

const providerName = text(64);
/** Passwords and secret keys may contain anything printable, but never nothing at all. */
const secretValue = z
  .string("Required")
  .min(1, "Required")
  .max(4096, "This is too long")
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
  .regex(/^[^\u0000-\u001f\u007f]*$/, "Must not contain control characters");

const hostOrIp = text(253).refine(
  (value) =>
    /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(
      value,
    ) || /^\[?[0-9a-fA-F:]+\]?$/.test(value),
  "Enter a hostname or IP address",
);

const portField = (fallback: number) =>
  z.preprocess(
    (value) => blank(value) ?? fallback,
    z.preprocess(
      digitsToNumber,
      z
        .number("Must be a number")
        .int("Must be a whole number")
        .min(1, "Use 1 to 65535")
        .max(65535, "Use 1 to 65535"),
    ),
  );

const usernameField = text(255);

/** The folder on a remote server that everything is kept under. No `.`, no `..`, no surprises. */
const remoteRoot = z.preprocess(
  (value) => blank(value) ?? "",
  z
    .string()
    .max(512, "This is too long")
    .refine(
      (value) => value === "" || isCleanAbsolutePath(value.startsWith("/") ? value : `/${value}`),
      "Use a folder path with no . or .. in it",
    )
    .transform((value) => (value === "/" ? value : value.replace(/\/+$/, ""))),
);

/** A path prefix inside an object store, where leading slashes mean nothing. */
const objectPrefix = z.preprocess(
  (value) => blank(value) ?? "",
  z
    .string()
    .max(512, "This is too long")
    .refine(
      (value) => value === "" || isCleanAbsolutePath(value.startsWith("/") ? value : `/${value}`),
      "Use a folder path with no . or .. in it",
    )
    .transform((value) => value.replace(/^\/+/, "").replace(/\/+$/, "")),
);

const absoluteLocalPath = text(1024).refine(
  isCleanAbsolutePath,
  "Use an absolute path such as /srv/backups, with no . or .. in it",
);

const optionalEndpoint = z.preprocess(
  blank,
  z
    .url("Enter a full URL such as https://s3.example.com")
    .refine(
      (value) => /^https?:\/\/[^/?#@\s]+\/?$/.test(value),
      "Use an http or https URL with no path, query or credentials",
    )
    .optional(),
);

const bucketName = text(63).regex(
  /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
  "Use lowercase letters, digits, dots and dashes",
);

const regionName = text(64).regex(/^[A-Za-z0-9-]+$/, "Use letters, digits and dashes");

const optionalStorageClass = z.preprocess(
  blank,
  z
    .string()
    .trim()
    .max(64, "This is too long")
    .regex(/^[A-Za-z0-9_]+$/, "Use letters, digits and underscores")
    .optional(),
);

const localFields = { name: providerName, path: absoluteLocalPath };
const sftpFields = {
  name: providerName,
  host: hostOrIp,
  port: portField(22),
  username: usernameField,
  password: secretValue,
  rootPath: remoteRoot,
};
const ftpFields = {
  name: providerName,
  host: hostOrIp,
  port: portField(21),
  username: usernameField,
  password: secretValue,
  rootPath: remoteRoot,
  /** Plain FTP sends the password in the clear. */
  tls: z.boolean().default(false),
};
const s3Fields = {
  name: providerName,
  accessKeyId: text(256),
  secretAccessKey: secretValue,
  bucket: bucketName,
  region: regionName,
  endpoint: optionalEndpoint,
  storageClass: optionalStorageClass,
  prefix: objectPrefix,
};
const oauthFields = { name: providerName, clientId: text(512), clientSecret: secretValue };

/** POST /api/v1/storage-providers. */
export const createStorageProviderRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), ...localFields }),
  z.object({ kind: z.literal("sftp"), ...sftpFields }),
  z.object({ kind: z.literal("ftp"), ...ftpFields }),
  z.object({ kind: z.literal("aws-s3"), ...s3Fields }),
  z.object({ kind: z.literal("cloudflare-r2"), ...s3Fields }),
  z.object({ kind: z.literal("digitalocean-spaces"), ...s3Fields }),
  z.object({ kind: z.literal("backblaze-b2"), ...s3Fields }),
  z.object({ kind: z.literal("wasabi"), ...s3Fields }),
  z.object({ kind: z.literal("generic-s3"), ...s3Fields }),
  z.object({ kind: z.literal("dropbox"), ...oauthFields }),
  z.object({ kind: z.literal("google-drive"), ...oauthFields }),
]);
export type CreateStorageProviderRequest = z.input<typeof createStorageProviderRequest>;
export type CreateStorageProviderFields = z.output<typeof createStorageProviderRequest>;

const keepSecret = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional());

/** PUT /api/v1/storage-providers/{id}. A secret left empty stays as it is. */
export const updateStorageProviderRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), ...localFields }),
  z.object({
    kind: z.literal("sftp"),
    ...sftpFields,
    password: keepSecret(secretValue),
    /** The server presented a key other than the one on record, and a person checked it. */
    trustNewHostKey: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("ftp"), ...ftpFields, password: keepSecret(secretValue) }),
  z.object({ kind: z.literal("aws-s3"), ...s3Fields, secretAccessKey: keepSecret(secretValue) }),
  z.object({ kind: z.literal("cloudflare-r2"), ...s3Fields, secretAccessKey: keepSecret(secretValue) }),
  z.object({ kind: z.literal("digitalocean-spaces"), ...s3Fields, secretAccessKey: keepSecret(secretValue) }),
  z.object({ kind: z.literal("backblaze-b2"), ...s3Fields, secretAccessKey: keepSecret(secretValue) }),
  z.object({ kind: z.literal("wasabi"), ...s3Fields, secretAccessKey: keepSecret(secretValue) }),
  z.object({ kind: z.literal("generic-s3"), ...s3Fields, secretAccessKey: keepSecret(secretValue) }),
  // The app credentials never change, and access comes from connecting: only the name can be edited.
  z.object({ kind: z.literal("dropbox"), name: providerName }),
  z.object({ kind: z.literal("google-drive"), name: providerName }),
]);
export type UpdateStorageProviderRequest = z.input<typeof updateStorageProviderRequest>;
export type UpdateStorageProviderFields = z.output<typeof updateStorageProviderRequest>;

export const storageProviderPath = z.object({ id: z.string().min(1).max(64) });

const publicLocal = z.object({ kind: z.literal("local"), path: z.string() });
const publicSftp = z.object({
  kind: z.literal("sftp"),
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  rootPath: z.string(),
  /** The SHA-256 of the key the server presented when it was first reached. */
  hostKey: z.string().nullable(),
});
const publicFtp = z.object({
  kind: z.literal("ftp"),
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  rootPath: z.string(),
  tls: z.boolean(),
});
const publicS3 = z.object({
  kind: z.enum(s3ProviderKinds),
  accessKeyId: z.string(),
  bucket: z.string(),
  region: z.string(),
  endpoint: z.string().nullable(),
  storageClass: z.string().nullable(),
  prefix: z.string(),
});
const publicOAuth = z.object({
  kind: z.enum(oauthProviderKinds),
  clientId: z.string(),
  /** The account the panel was connected to. Null until it is connected. */
  account: z.string().nullable(),
});

/** What a form may show about a destination. Never a password, key or token. */
export const storageProviderConfig = z.discriminatedUnion("kind", [
  publicLocal,
  publicSftp,
  publicFtp,
  publicS3,
  publicOAuth,
]);
export type StorageProviderConfig = z.infer<typeof storageProviderConfig>;

/** `ready` can take backups now. `disconnected` needs someone to connect it first. */
export const storageProviderStatus = z.enum(["ready", "disconnected"]);
export type StorageProviderStatus = z.infer<typeof storageProviderStatus>;

/** One row of Settings, Storage providers. Secrets stay on the server. */
export const storageProviderEntry = z.object({
  id: z.string(),
  name: z.string(),
  kind: storageProviderKind,
  /** The Local Disk every install starts with. It can be neither edited nor removed. */
  builtIn: z.boolean(),
  status: storageProviderStatus,
  /** A one-line, password-free description of where files go. */
  location: z.string(),
  /** False for a folder on this server, whose copies go with it if the server is lost. */
  offHost: z.boolean(),
  /** How many backup configurations send their files here. */
  usedBy: z.number().int().min(0),
  /** What its credentials must be allowed to do. A save tries each of them. */
  requiredPermissions: z.array(z.string()),
  /** Null until a check has run. A failed check keeps the provider, marked. */
  lastCheckAt: z.iso.datetime().nullable(),
  lastCheckError: z.string().nullable(),
  config: storageProviderConfig,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type StorageProviderEntry = z.infer<typeof storageProviderEntry>;

export const storageProviderList = z.object({
  providers: z.array(storageProviderEntry),
  /** The URL to register as the redirect URL of a Dropbox or Google Drive app. */
  oauthRedirectUrl: z.string(),
});
export type StorageProviderList = z.infer<typeof storageProviderList>;

/** A destination that can be offered in a form. Disconnected ones are left out. */
export const storageProviderOption = z.object({
  id: z.string(),
  name: z.string(),
  kind: storageProviderKind,
  offHost: z.boolean(),
});
export type StorageProviderOption = z.infer<typeof storageProviderOption>;

export const storageProviderOptions = z.object({ options: z.array(storageProviderOption) });
export type StorageProviderOptions = z.infer<typeof storageProviderOptions>;

export const oauthStartResponse = z.object({ authorizationUrl: z.string() });
export type OAuthStartResponse = z.infer<typeof oauthStartResponse>;

export const checkStorageProviderResponse = z.object({ ok: z.boolean(), error: z.string().nullable() });
export type CheckStorageProviderResponse = z.infer<typeof checkStorageProviderResponse>;

export const storageProviderActionTypes = {
  create: "storage-provider.create",
  update: "storage-provider.update",
  delete: "storage-provider.delete",
  connect: "storage-provider.connect",
  disconnect: "storage-provider.disconnect",
} as const;

/** Provider-level failures a form can translate. Any other failure carries its own message. */
export const storageErrorCodes = {
  unreachable: "could_not_connect",
  denied: "access_denied",
  hostKeyChanged: "host_key_changed",
  notConnected: "provider_not_connected",
} as const;
