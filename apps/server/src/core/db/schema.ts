import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const millis = (name: string) => integer(name, { mode: "timestamp_ms" });

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    /** Sealed. Non-null means two-factor authentication is on. */
    totpSecret: text("totp_secret"),
    /** Sealed. Set while a setup dialog is open, and separate so it cannot affect the active secret. */
    totpPendingSecret: text("totp_pending_secret"),
    /** The last time step accepted, so a code cannot be used twice. */
    totpLastStep: integer("totp_last_step"),
    createdAt: millis("created_at").notNull(),
    updatedAt: millis("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
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
    createdAt: millis("created_at").notNull(),
    lastUsedAt: millis("last_used_at"),
    expiresAt: millis("expires_at"),
  },
  (table) => [index("api_tokens_user_id_idx").on(table.userId)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: millis("updated_at").notNull(),
});

export const projects = sqliteTable("projects", {
  name: text("name").primaryKey(),
  /** Dotenv text every service of the project receives. */
  env: text("env").notNull().default(""),
  createdAt: millis("created_at").notNull(),
  updatedAt: millis("updated_at").notNull(),
});

export const services = sqliteTable(
  "services",
  {
    projectName: text("project_name")
      .notNull()
      .references(() => projects.name, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    /** Type-specific configuration. Validated with Zod by the feature that owns the type. */
    spec: text("spec", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: millis("created_at").notNull(),
    updatedAt: millis("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectName, table.name] })],
);

export const domains = sqliteTable(
  "domains",
  {
    id: text("id").primaryKey(),
    projectName: text("project_name").notNull(),
    serviceName: text("service_name").notNull(),
    host: text("host").notNull(),
    path: text("path").notNull().default("/"),
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
    /** Null means the default certificate resolver. */
    certificateResolver: text("certificate_resolver"),
    /** Answers on every direct subdomain of `host` instead of on `host` itself. */
    wildcard: integer("wildcard", { mode: "boolean" }).notNull().default(false),
    /** Names of the Traefik middlewares this domain uses. */
    middlewares: text("middlewares", { mode: "json" }).$type<string[]>().notNull().default([]),
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
    status: text("status", { enum: ["queued", "running", "succeeded", "failed", "cancelled"] }).notNull(),
    // Plain names, not references: the record must outlive the service it describes.
    projectName: text("project_name"),
    serviceName: text("service_name"),
    actorEmail: text("actor_email"),
    hasLog: integer("has_log", { mode: "boolean" }).notNull().default(false),
    logTruncated: integer("log_truncated", { mode: "boolean" }).notNull().default(false),
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
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
  ],
);
