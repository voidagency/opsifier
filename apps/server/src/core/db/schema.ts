import type { DeploymentRecord, ProjectGrant } from "@opsifier/contract";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const millis = (name: string) => integer(name, { mode: "timestamp_ms" });

/** Why a service's runtime can't be vouched for, and the deployment that left it so. */
export interface RuntimeUncertainty {
  reason: "interrupted" | "restore_failed";
  actionId: string;
}

/** The image the last successful deployment put in place, exactly. */
export interface DeployedImage {
  /** The name it was asked for under, as saved or as built. */
  image: string;
  imageId: string;
  /** `repository@sha256:...` for what came from a registry. */
  digest: string | null;
  commit: string | null;
  /** The version kept of it. Null for what has no versions, such as a database. */
  release: number | null;
}

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    /** What the person is called. Only the owner is asked for one, when claiming the panel. */
    name: text("name").notNull().default(""),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    /** Sealed. Non-null means two-factor authentication is on. */
    totpSecret: text("totp_secret"),
    /** Sealed. Set while a setup dialog is open, and separate so it cannot affect the active secret. */
    totpPendingSecret: text("totp_pending_secret"),
    /** The last time step accepted, so a code cannot be used twice. */
    totpLastStep: integer("totp_last_step"),
    /** The account that claimed the panel: it can never be deleted or demoted. */
    isOwner: integer("is_owner", { mode: "boolean" }).notNull().default(false),
    /** May open a shell on the server, list its disk and reboot it. The owner always may. */
    hostAdmin: integer("host_admin", { mode: "boolean" }).notNull().default(false),
    /** Set while the account may not sign in. Its rights are kept, ready for when it comes back. */
    deactivatedAt: millis("deactivated_at"),
    createdAt: millis("created_at").notNull(),
    updatedAt: millis("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    uniqueIndex("users_one_owner").on(table.isOwner).where(sql`${table.isOwner} = 1`),
    check("users_role_check", sql`${table.role} IN ('admin', 'member')`),
  ],
);

export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the code. A code is used up by deleting its row, so of two requests one wins. */
    codeHash: text("code_hash").notNull(),
    createdAt: millis("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.codeHash] })],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** True when the user asked to be remembered: the cookie then outlives the browser. */
    persistent: integer("persistent", { mode: "boolean" }).notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: millis("created_at").notNull(),
    expiresAt: millis("expires_at").notNull(),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** The first characters of the token, shown so people can tell tokens apart. */
    tokenPrefix: text("token_prefix").notNull(),
    /** `read` keys can only use safe methods, however much their owner may do. */
    level: text("level", { enum: ["read", "write"] })
      .notNull()
      .default("write"),
    /** The only projects the key reaches. Null means every project its owner reaches. */
    projects: text("projects", { mode: "json" }).$type<string[] | null>(),
    createdAt: millis("created_at").notNull(),
    lastUsedAt: millis("last_used_at"),
    expiresAt: millis("expires_at"),
  },
  (table) => [index("api_tokens_user_id_idx").on(table.userId)],
);

/** Who may do what inside a project. Administrators reach everything without a row here. */
export const projectMembers = sqliteTable(
  "project_members",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectName: text("project_name")
      .notNull()
      .references(() => projects.name, { onDelete: "cascade" }),
    role: text("role", { enum: ["viewer", "operator"] }).notNull(),
    createdAt: millis("created_at").notNull(),
    updatedAt: millis("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.projectName] }),
    index("project_members_project_idx").on(table.projectName),
    check("project_members_role_check", sql`${table.role} IN ('viewer', 'operator')`),
  ],
);

/**
 * An account someone was asked to create, with a link that works once. Only the link's hash is kept,
 * and the invitation goes with the administrator who sent it.
 */
export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    /** Trimmed and in lower case, as it will sign in. One invitation per address. */
    email: text("email").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    /** What a member will reach, checked again against the projects that exist when it is accepted. */
    projects: text("projects", { mode: "json" }).$type<ProjectGrant[]>().notNull(),
    /** SHA-256 of the current link's token. Sending the invitation again replaces it. */
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** How the current link reaches the person: handed to an administrator, or e-mailed. */
    delivery: text("delivery", { enum: ["link", "sending", "sent", "failed"] }).notNull(),
    /** The SMTP channel of the latest e-mail, by name, so the record survives the channel. */
    channelName: text("channel_name"),
    sentAt: millis("sent_at"),
    /** Why the latest e-mail was not sent, with any secret removed. */
    deliveryError: text("delivery_error"),
    createdAt: millis("created_at").notNull(),
    expiresAt: millis("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("invitations_email_unique").on(table.email),
    index("invitations_invited_by_idx").on(table.invitedBy),
    check("invitations_role_check", sql`${table.role} IN ('admin', 'member')`),
    check("invitations_delivery_check", sql`${table.delivery} IN ('link', 'sending', 'sent', 'failed')`),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: millis("updated_at").notNull(),
});

export const projects = sqliteTable("projects", {
  name: text("name").primaryKey(),
  /** Dotenv text every service of the project receives, sealed. Empty when there is none. */
  sealedEnv: text("env").notNull().default(""),
  /** Values these variables used to have, sealed, so that output can go on hiding them. */
  sealedRetired: text("sealed_retired"),
  createdAt: millis("created_at").notNull(),
  updatedAt: millis("updated_at").notNull(),
});

export const services = sqliteTable(
  "services",
  {
    /** Stays the same for the life of the service, whatever it is renamed to or moved into. */
    id: text("id"),
    projectName: text("project_name")
      .notNull()
      .references(() => projects.name, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    /** Type-specific configuration. Validated with Zod by the feature that owns the type. */
    spec: text("spec", { mode: "json" }).$type<unknown>().notNull(),
    /** Sealed: what the last successful deployment put in place. Null until there has been one. */
    applied: text("applied"),
    /** Whether the last deployment found the service answering. Null when it could not tell. */
    answering: integer("answering", { mode: "boolean" }),
    /** Set while nobody can say for certain what is running. Only a successful deployment clears it. */
    runtimeUncertain: text("runtime_uncertain", { mode: "json" }).$type<RuntimeUncertainty | null>(),
    /** The image the last successful deployment ran. Gone with what ran it, as after a rename. */
    deployed: text("deployed", { mode: "json" }).$type<DeployedImage | null>(),
    createdAt: millis("created_at").notNull(),
    updatedAt: millis("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectName, table.name] }),
    uniqueIndex("services_id_unique").on(table.id),
  ],
);

/**
 * What a successful deployment leaves behind to go back to. Rows belong to the service by its
 * identifier, so they follow it through a rename. They are only ever added and removed: a kept version
 * cannot change.
 */
export const serviceReleases = sqliteTable(
  "service_releases",
  {
    serviceId: text("service_id").notNull(),
    /** Counts up for each service and is never reused. */
    number: integer("number").notNull(),
    image: text("image").notNull(),
    imageId: text("image_id").notNull(),
    digest: text("digest"),
    sizeBytes: integer("size_bytes"),
    requestedRef: text("requested_ref"),
    builtCommit: text("built_commit"),
    ociRevision: text("oci_revision"),
    /** The version this one went back to, when it is a rollback. */
    rollbackOf: integer("rollback_of"),
    actorEmail: text("actor_email"),
    actionId: text("action_id"),
    /** Sealed: the compiled configuration with its secrets filled in. Never leaves the server. */
    snapshot: text("snapshot").notNull(),
    createdAt: millis("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.serviceId, table.number] })],
);

export const domains = sqliteTable(
  "domains",
  {
    id: text("id").primaryKey(),
    projectName: text("project_name").notNull(),
    serviceName: text("service_name").notNull(),
    host: text("host").notNull(),
    path: text("path").notNull().default("/"),
    /** Takes `path` off the request before it reaches the container. */
    stripPath: integer("strip_path", { mode: "boolean" }).notNull().default(false),
    port: integer("port").notNull(),
    https: integer("https", { mode: "boolean" }).notNull().default(true),
    /** The one domain behind Open, `$(PRIMARY_DOMAIN)` and `PORT`. */
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    /** HTTP or HTTPS towards the container. */
    destinationProtocol: text("destination_protocol", { enum: ["http", "https"] })
      .notNull()
      .default("http"),
    /** Prefixed to the request path before it reaches the container. */
    destinationPath: text("destination_path").notNull().default("/"),
    /** With an HTTPS upstream, the name its certificate must carry. Null means the public hostname. */
    upstreamServerName: text("upstream_server_name"),
    /** With an HTTPS upstream, the PEM certificates to trust. Null means the public authorities. */
    upstreamCa: text("upstream_ca"),
    /** Null means the default certificate resolver. */
    certificateResolver: text("certificate_resolver"),
    /** Answers on every direct subdomain of `host` instead of on `host` itself. */
    wildcard: integer("wildcard", { mode: "boolean" }).notNull().default(false),
    /** Names of the Traefik middlewares this domain uses. */
    middlewares: text("middlewares", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** On a Compose stack, the child this routes to. Empty until one is chosen. Null on anything else. */
    composeService: text("compose_service"),
    createdAt: millis("created_at").notNull(),
    updatedAt: millis("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "domains_service_fk",
      columns: [table.projectName, table.serviceName],
      foreignColumns: [services.projectName, services.name],
    }).onDelete("cascade"),
    // A wildcard entry and the exact entry for its root are different routes.
    uniqueIndex("domains_host_path_unique").on(table.host, table.path, table.wildcard),
    index("domains_service_idx").on(table.projectName, table.serviceName),
    uniqueIndex("domains_one_primary_per_service")
      .on(table.projectName, table.serviceName)
      .where(sql`${table.isPrimary} = 1`),
    check("domains_port_check", sql`${table.port} BETWEEN 1 AND 65535`),
  ],
);

export const actions = sqliteTable(
  "actions",
  {
    /** Insertion order: the stable sort key behind newest-first paging. */
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed", "cancelled", "uncertain"],
    }).notNull(),
    // Plain names, not references: the record must outlive the service it describes.
    projectName: text("project_name"),
    serviceName: text("service_name"),
    actorEmail: text("actor_email"),
    /** How this came to be started. Null on rows from before it was recorded. */
    origin: text("origin", { enum: ["session", "api_key", "trigger", "webhook", "system"] }),
    /** What the origin leaves out, such as an API key's name or the commit a push announced. */
    originDetail: text("origin_detail"),
    /** On a deployment: what it was asked for and what it really put in place. */
    deployment: text("deployment", { mode: "json" }).$type<DeploymentRecord | null>(),
    hasLog: integer("has_log", { mode: "boolean" }).notNull().default(false),
    logTruncated: integer("log_truncated", { mode: "boolean" }).notNull().default(false),
    /** The step under way, or the last one reached: a key the interface has words for. */
    phase: text("phase"),
    error: text("error"),
    createdAt: millis("created_at").notNull(),
    startedAt: millis("started_at"),
    finishedAt: millis("finished_at"),
  },
  (table) => [
    index("actions_status_idx").on(table.status),
    index("actions_service_idx").on(table.projectName, table.serviceName),
    index("actions_type_idx").on(table.type),
    check(
      "actions_status_check",
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'uncertain')`,
    ),
  ],
);

/**
 * One row per bucket of a measured series. `scope` is `system` or `<project>/<service>`, and
 * `resolution` is the width of the bucket in seconds: raw readings first, then coarser roll-ups.
 */
export const metricSamples = sqliteTable(
  "metric_samples",
  {
    scope: text("scope").notNull(),
    resolution: integer("resolution").notNull(),
    /** Start of the bucket, in milliseconds. */
    at: integer("at").notNull(),
    cpu: real("cpu"),
    memoryUsed: real("memory_used"),
    memoryTotal: real("memory_total"),
    diskUsed: real("disk_used"),
    diskTotal: real("disk_total"),
    rx: real("rx"),
    tx: real("tx"),
    /** How many raw readings went into this bucket. */
    readings: integer("readings").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.resolution, table.at] }),
    index("metric_samples_resolution_at_idx").on(table.resolution, table.at),
  ],
);

/** A hostname that points at servers outside the panel, rather than at one of its services. */
export const customDomains = sqliteTable(
  "custom_domains",
  {
    id: text("id").primaryKey(),
    host: text("host").notNull(),
    path: text("path").notNull().default("/"),
    stripPath: integer("strip_path", { mode: "boolean" }).notNull().default(false),
    https: integer("https", { mode: "boolean" }).notNull().default(true),
    servers: text("servers", { mode: "json" }).$type<Array<{ url: string; weight: number }>>().notNull(),
    certificateResolver: text("certificate_resolver"),
    wildcard: integer("wildcard", { mode: "boolean" }).notNull().default(false),
    middlewares: text("middlewares", { mode: "json" }).$type<string[]>().notNull().default([]),
    createdAt: millis("created_at").notNull(),
    updatedAt: millis("updated_at").notNull(),
  },
  (table) => [uniqueIndex("custom_domains_host_path_unique").on(table.host, table.path, table.wildcard)],
);

export const notificationChannels = sqliteTable("notification_channels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  /** Everything but the secrets, validated by the contract when it is read. */
  config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  /** Sealed JSON holding the channel's secrets. Null when it has none. */
  sealedSecrets: text("sealed_secrets"),
  events: text("events", { mode: "json" }).$type<unknown>().notNull(),
  /** When the disk-usage event last fired for this channel, so it fires once per cron match. */
  lastDiskCheckAt: millis("last_disk_check_at"),
  createdAt: millis("created_at").notNull(),
  updatedAt: millis("updated_at").notNull(),
});

/** One message for one channel. Kept so that retries, duplicates and failures can be seen. */
export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    id: text("id").primaryKey(),
    /** The same across retries, and what makes a duplicate a duplicate. */
    eventId: text("event_id").notNull(),
    channelId: text("channel_id"),
    channelName: text("channel_name").notNull(),
    event: text("event").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: millis("created_at").notNull(),
    updatedAt: millis("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("notification_deliveries_event_channel_unique").on(table.eventId, table.channelId),
    index("notification_deliveries_created_idx").on(table.createdAt),
  ],
);

/**
 * One Git push delivery that started a deployment, kept so that a redelivery starts nothing, across
 * restarts too. A sender's delivery id is not covered by its signature, so the hash of the signed body
 * is checked as well: a captured delivery replayed under a new id is still the same delivery.
 */
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    /** The webhook's own id, which outlives rotations and renames. */
    hookId: text("hook_id").notNull(),
    deliveryId: text("delivery_id"),
    bodyHash: text("body_hash").notNull(),
    actionId: text("action_id"),
    createdAt: millis("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("webhook_deliveries_hook_delivery_unique").on(table.hookId, table.deliveryId),
    uniqueIndex("webhook_deliveries_hook_body_unique").on(table.hookId, table.bodyHash),
    index("webhook_deliveries_created_idx").on(table.createdAt),
  ],
);

/** The SSH host keys Git may connect to. Nothing outside this list is ever trusted. */
export const gitKnownHosts = sqliteTable(
  "git_known_hosts",
  {
    id: text("id").primaryKey(),
    host: text("host").notNull(),
    port: integer("port").notNull().default(22),
    keyType: text("key_type").notNull(),
    publicKey: text("public_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    /** Who confirmed it. Null for a key learned on first contact before this registry existed. */
    addedBy: text("added_by"),
    createdAt: millis("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("git_known_hosts_key_unique").on(table.host, table.port, table.keyType, table.publicKey),
  ],
);

/** A line a service printed, kept while log storage is on and within its limits. */
export const logEntries = sqliteTable(
  "log_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectName: text("project_name").notNull(),
    serviceName: text("service_name").notNull(),
    at: integer("at").notNull(),
    stream: text("stream", { enum: ["stdout", "stderr"] }).notNull(),
    level: text("level", { enum: ["error", "warn", "info", "debug", "none"] }).notNull(),
    line: text("line").notNull(),
  },
  (table) => [
    index("log_entries_service_at_idx").on(table.projectName, table.serviceName, table.at),
    index("log_entries_at_idx").on(table.at),
  ],
);

/** Where each service's stored lines end, exactly, so that a restart picks up instead of starting over. */
export const logCursors = sqliteTable(
  "log_cursors",
  {
    projectName: text("project_name").notNull(),
    serviceName: text("service_name").notNull(),
    /** Docker's own timestamp of the newest stored line, which is finer than `log_entries.at`. */
    lastAt: text("last_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectName, table.serviceName] })],
);

/**
 * A console whose process may still be running. Written before the process starts and removed once it
 * has ended, so that the next boot can find what a dead panel left behind. The id is the marker in that
 * process's environment and also the id of its entry on the activity log.
 */
export const consoleSessions = sqliteTable("console_sessions", {
  id: text("id").primaryKey(),
  projectName: text("project_name").notNull(),
  serviceName: text("service_name").notNull(),
  /** The task it was opened in or, for a Compose stack, the container. */
  task: text("task").notNull(),
  startedAt: millis("started_at").notNull(),
});

/** Where backups can be sent. Only the settings that are safe to show are stored in the clear. */
export const storageProviders = sqliteTable(
  "storage_providers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    builtIn: integer("built_in", { mode: "boolean" }).notNull().default(false),
    /** Host, bucket, path and the like, validated by the contract when it is read. */
    config: text("config", { mode: "json" }).$type<unknown>().notNull(),
    /** Passwords, keys and tokens, sealed. Null when there are none. */
    sealedSecrets: text("sealed_secrets"),
    /** False until a Dropbox or Google Drive entry has been authorized. */
    connected: integer("connected", { mode: "boolean" }).notNull().default(true),
    lastCheckAt: millis("last_check_at"),
    lastCheckError: text("last_check_error"),
    createdAt: millis("created_at").notNull(),
    updatedAt: millis("updated_at").notNull(),
  },
  (table) => [uniqueIndex("storage_providers_name_unique").on(table.name)],
);

/** One way of backing up one database or volume. Follows its service when that is renamed. */
export const backupConfigs = sqliteTable(
  "backup_configs",
  {
    id: text("id").primaryKey(),
    projectName: text("project_name").notNull(),
    serviceName: text("service_name").notNull(),
    kind: text("kind", { enum: ["database", "volume"] }).notNull(),
    /** What each run exports. A volume configuration's is always `volume`, whatever is stored. */
    scope: text("scope", { enum: ["database", "instance", "accounts", "volume"] })
      .notNull()
      .default("database"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    schedule: text("schedule").notNull(),
    /** How many scheduled runs to keep. Null keeps all of them. */
    retention: integer("retention"),
    databaseName: text("database_name"),
    volumeName: text("volume_name"),
    /** Null once its provider has been deleted. The row stays so that its history makes sense. */
    storageProviderId: text("storage_provider_id").references(() => storageProviders.id, {
      onDelete: "set null",
    }),
    path: text("path").notNull(),
    /** The next due time. Stored, so that the schedule outlives the panel. */
    nextRunAt: millis("next_run_at"),
    createdAt: millis("created_at").notNull(),
    updatedAt: millis("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      name: "backup_configs_service_fk",
      columns: [table.projectName, table.serviceName],
      foreignColumns: [services.projectName, services.name],
    }).onDelete("cascade"),
    index("backup_configs_service_idx").on(table.projectName, table.serviceName),
    index("backup_configs_next_run_idx").on(table.nextRunAt),
    check("backup_configs_kind_check", sql`${table.kind} IN ('database', 'volume')`),
  ],
);

/** One run of a backup, whatever its outcome. The file it produced outlives the service it came from. */
export const backups = sqliteTable(
  "backups",
  {
    /** Insertion order: the stable sort key behind newest-first listings. */
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    // Plain names, not references: the record must outlive the service and the provider.
    projectName: text("project_name").notNull(),
    serviceName: text("service_name").notNull(),
    configId: text("config_id").references(() => backupConfigs.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ["database", "volume"] }).notNull(),
    /** Retention only touches `schedule`: a backup taken by hand is someone's decision to keep it. */
    origin: text("origin", { enum: ["manual", "schedule", "safety"] }).notNull(),
    name: text("name"),
    status: text("status", { enum: ["running", "succeeded", "failed", "cancelled"] }).notNull(),
    databaseName: text("database_name"),
    volumeName: text("volume_name"),
    engine: text("engine"),
    engineVersion: text("engine_version"),
    format: text("format"),
    scope: text("scope", { enum: ["database", "instance", "accounts", "volume"] }).notNull(),
    storageProviderId: text("storage_provider_id"),
    storageProviderName: text("storage_provider_name").notNull(),
    path: text("path").notNull(),
    sizeBytes: integer("size_bytes"),
    sha256: text("sha256"),
    actionId: text("action_id"),
    error: text("error"),
    cleanupError: text("cleanup_error"),
    createdAt: millis("created_at").notNull(),
    finishedAt: millis("finished_at"),
    deletedAt: millis("deleted_at"),
  },
  (table) => [
    index("backups_service_idx").on(table.projectName, table.serviceName, table.seq),
    index("backups_config_idx").on(table.configId),
    index("backups_status_idx").on(table.status),
  ],
);

/** One restore: where it came from, what it replaced, how far it got and how it ended. */
export const backupRestores = sqliteTable(
  "backup_restores",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    projectName: text("project_name").notNull(),
    serviceName: text("service_name").notNull(),
    kind: text("kind", { enum: ["database", "volume"] }).notNull(),
    /** What is being put back, which decides how an interrupted restore is settled at boot. */
    scope: text("scope", { enum: ["database", "instance", "accounts", "volume"] })
      .notNull()
      .default("database"),
    backupId: text("backup_id"),
    storageProviderName: text("storage_provider_name").notNull(),
    sourcePath: text("source_path").notNull(),
    databaseName: text("database_name"),
    volumeName: text("volume_name"),
    status: text("status", { enum: ["running", "succeeded", "failed", "cancelled"] }).notNull(),
    phase: text("phase").notNull(),
    safetyBackupId: text("safety_backup_id"),
    /** The folder a volume restore moved the old contents to. */
    earlierCopy: text("earlier_copy"),
    /** How many tasks were running before the restore stopped them, for a volume. */
    previousReplicas: integer("previous_replicas"),
    actorEmail: text("actor_email"),
    actionId: text("action_id"),
    error: text("error"),
    /** The panel died at a point it can't recover from by itself. Data operations stay refused. */
    unresolved: integer("unresolved", { mode: "boolean" }).notNull().default(false),
    createdAt: millis("created_at").notNull(),
    finishedAt: millis("finished_at"),
  },
  (table) => [
    index("backup_restores_service_idx").on(table.projectName, table.serviceName, table.seq),
    index("backup_restores_status_idx").on(table.status),
  ],
);

/**
 * A named volume left on the server when the service using it was destroyed. A row is what makes a
 * volume deletable by hand, so a deletion can never reach a volume the panel did not keep itself.
 */
export const retainedVolumes = sqliteTable(
  "retained_volumes",
  {
    name: text("name").primaryKey(),
    // Plain names, not references: the record must outlive the service and its project.
    projectName: text("project_name").notNull(),
    serviceName: text("service_name").notNull(),
    kind: text("kind", { enum: ["app", "database", "compose"] }).notNull(),
    retainedAt: millis("retained_at").notNull(),
  },
  (table) => [
    index("retained_volumes_service_idx").on(table.projectName, table.serviceName),
    check("retained_volumes_kind_check", sql`${table.kind} IN ('app', 'database', 'compose')`),
  ],
);

/** The next due time of a script's schedule. One row per script that has a schedule. */
export const scriptSchedules = sqliteTable(
  "script_schedules",
  {
    projectName: text("project_name").notNull(),
    serviceName: text("service_name").notNull(),
    scriptName: text("script_name").notNull(),
    /** Stored, so that a schedule outlives the panel. */
    nextRunAt: millis("next_run_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectName, table.serviceName, table.scriptName] }),
    foreignKey({
      name: "script_schedules_service_fk",
      columns: [table.projectName, table.serviceName],
      foreignColumns: [services.projectName, services.name],
    }).onDelete("cascade"),
    index("script_schedules_next_run_idx").on(table.nextRunAt),
  ],
);

/**
 * One attempt to run a script, written before anything starts. What a process in a container goes on
 * doing after the panel dies is found again through this row: `id` is the marker in its environment.
 */
export const scriptRuns = sqliteTable(
  "script_runs",
  {
    /** Insertion order: the stable sort key behind newest-first paging. */
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    projectName: text("project_name").notNull(),
    serviceName: text("service_name").notNull(),
    scriptName: text("script_name").notNull(),
    origin: text("origin", { enum: ["manual", "api", "schedule", "hook", "console"] }).notNull(),
    actorEmail: text("actor_email"),
    originDetail: text("origin_detail"),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed", "timed_out", "cancelled", "skipped", "unknown"],
    }).notNull(),
    exitCode: integer("exit_code"),
    taskId: text("task_id"),
    taskSlot: integer("task_slot"),
    /** Docker's id for the process, which is how a later panel asks how it went. */
    execId: text("exec_id"),
    maxDurationSeconds: integer("max_duration_seconds").notNull(),
    noteCode: text("note_code"),
    note: text("note"),
    /** The end of what it printed, bounded by the contract. Written while it runs, so a crash keeps most of it. */
    output: text("output").notNull().default(""),
    outputTruncated: integer("output_truncated", { mode: "boolean" }).notNull().default(false),
    outputComplete: integer("output_complete", { mode: "boolean" }).notNull().default(true),
    dueAt: millis("due_at"),
    createdAt: millis("created_at").notNull(),
    startedAt: millis("started_at"),
    finishedAt: millis("finished_at"),
  },
  (table) => [
    foreignKey({
      name: "script_runs_service_fk",
      columns: [table.projectName, table.serviceName],
      foreignColumns: [services.projectName, services.name],
    }).onDelete("cascade"),
    index("script_runs_script_idx").on(table.projectName, table.serviceName, table.scriptName),
    index("script_runs_status_idx").on(table.status),
    check(
      "script_runs_status_check",
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'skipped', 'unknown')`,
    ),
    check(
      "script_runs_origin_check",
      sql`${table.origin} IN ('manual', 'api', 'schedule', 'hook', 'console')`,
    ),
  ],
);

/** What a template created in a project, so its parts can be shown, resumed and removed together. */
export const templateInstalls = sqliteTable(
  "template_installs",
  {
    id: text("id").primaryKey(),
    projectName: text("project_name")
      .notNull()
      .references(() => projects.name, { onDelete: "cascade" }),
    templateId: text("template_id").notNull(),
    templateVersion: text("template_version").notNull(),
    templateName: text("template_name").notNull(),
    category: text("category").notNull(),
    /** True when it came from a pasted document, not from the catalogue. */
    custom: integer("custom", { mode: "boolean" }).notNull().default(false),
    /** What to do next, already filled in with this install's names. */
    instructions: text("instructions", { mode: "json" }).$type<{ en: string; fr: string } | null>(),
    createdAt: millis("created_at").notNull(),
  },
  (table) => [index("template_installs_project_idx").on(table.projectName)],
);
