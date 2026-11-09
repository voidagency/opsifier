import { z } from "zod";
import { resourceName } from "./common";
import { buildPath, gitRef, gitRemoteUrl, isSafeRelativeFile } from "./service-tabs/source";

/** Where an inline Compose file is written, and what a Git source reads unless told otherwise. */
export const COMPOSE_DEFAULT_FILE = "docker-compose.yml";
export const MAX_COMPOSE_CHARS = 256 * 1024;

/** A child of a stack, as Compose names it. Also the last part of the address the proxy reaches it on. */
const COMPOSE_CHILD = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;

export const isRoutableComposeChild = (name: string): boolean => COMPOSE_CHILD.test(name);

export const composeChildName = z
  .string()
  .trim()
  .refine(isRoutableComposeChild, "Use the name of a service in the Compose file");

/** POST /api/v1/projects/{project}/compose */
export const createComposeRequest = z.object({ name: resourceName });
export type CreateComposeRequest = z.infer<typeof createComposeRequest>;

const composeFile = z
  .string()
  .trim()
  .min(1, "Required")
  .max(1024, "This is too long")
  .refine(isSafeRelativeFile, "Use a path inside the repository, such as docker-compose.yml");

/** Where a stack comes from. Passwords and keys never travel here: only addresses and text. */
export const composeSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inline"), content: z.string() }),
  z.object({
    type: z.literal("git"),
    url: z.string(),
    ref: z.string(),
    path: z.string(),
    file: z.string(),
  }),
]);
export type ComposeSource = z.infer<typeof composeSource>;

/** PUT /api/v1/projects/{project}/services/{service}/compose/source */
export const saveComposeSourceRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inline"),
    content: z.string().max(MAX_COMPOSE_CHARS, "This is too long"),
  }),
  z.object({
    type: z.literal("git"),
    url: gitRemoteUrl,
    ref: gitRef,
    path: buildPath.default("/"),
    file: composeFile.default(COMPOSE_DEFAULT_FILE),
  }),
]);
export type SaveComposeSourceRequest = z.input<typeof saveComposeSourceRequest>;

/**
 * Worst first. `error` stops a deploy, `host` lets a stack reach outside its containers and needs a
 * person to say so, and `warning` is advice that never stops anything.
 */
export const composeIssueSeverities = ["error", "host", "warning"] as const;
export const composeIssueSeverity = z.enum(composeIssueSeverities);
export type ComposeIssueSeverity = z.infer<typeof composeIssueSeverity>;

export const composeIssueCodes = [
  // Errors: this file can't run as written, or reaches a network its project doesn't own.
  "no_services",
  "unknown_dependency",
  "escapes_stack",
  "foreign_network",
  // Host access: each one reaches past the container boundary.
  "privileged",
  "docker_socket",
  "data_directory",
  "host_path",
  "host_namespace",
  "capabilities",
  "devices",
  "security_options",
  "external_resource",
  // Warnings: it runs, but something about it will surprise someone.
  "container_name",
  "published_port",
  "port_taken",
  "no_restart_policy",
  "profiles",
  "network_mode",
  "unroutable_name",
] as const;
export const composeIssueCode = z.enum(composeIssueCodes);
export type ComposeIssueCode = z.infer<typeof composeIssueCode>;

/** One thing the check found. The UI words it: only the code and the facts travel. */
export const composeIssue = z.object({
  severity: composeIssueSeverity,
  code: composeIssueCode,
  /** The service in the file it is about. Null when it is about the file as a whole. */
  service: z.string().nullable(),
  /** The value that caused it, such as a port or a path. */
  detail: z.string().nullable(),
});
export type ComposeIssue = z.infer<typeof composeIssue>;

/** GET /api/v1/projects/{project}/services/{service}/compose: what the Source and Domains tabs read. */
export const composeDetail = z.object({
  /** Null until a source is saved. */
  source: composeSource.nullable(),
  /** The file as the panel last saw it. Null when a Git source has not been fetched yet. */
  content: z.string().nullable(),
  issues: z.array(composeIssue),
  /** What the YAML parser said about a file it could not read, in its own words. */
  parseError: z.string().nullable(),
  /** The services the file defines, in file order. */
  services: z.array(z.string()),
  /** True when the file reaches the host and nobody has confirmed this version of it yet. */
  acknowledgementRequired: z.boolean(),
  /** Whether the current version of the file has been confirmed. */
  acknowledged: z.boolean(),
  /** Written next to the Compose file before each deploy, when set. */
  envFile: z.boolean(),
  /** The SSH key's public half, for a private repository. */
  sshPublicKey: z.string().nullable(),
});
export type ComposeDetail = z.infer<typeof composeDetail>;

/** POST /api/v1/projects/{project}/services/{service}/compose/acknowledge */
export const acknowledgeComposeRequest = z.object({
  /** Compared with the file, so a confirmation never carries over to a file nobody has read. */
  content: z.string().max(MAX_COMPOSE_CHARS),
});
export type AcknowledgeComposeRequest = z.infer<typeof acknowledgeComposeRequest>;

/** PUT /api/v1/projects/{project}/services/{service}/compose/env-file */
export const composeEnvFileSettings = z.object({ enabled: z.boolean() });
export type ComposeEnvFileSettings = z.infer<typeof composeEnvFileSettings>;

/** Where a child stands. `completed` finished cleanly during its deploy and is not expected to run. */
export const composeChildStates = [
  "running",
  "starting",
  "unhealthy",
  "failed",
  "stopped",
  "completed",
] as const;
export const composeChildState = z.enum(composeChildStates);
export type ComposeChildState = z.infer<typeof composeChildState>;

export const composeContainer = z.object({
  id: z.string(),
  /** As Docker names it: `<project>_<service>-<child>-<replica>`. */
  name: z.string(),
  image: z.string(),
  state: composeChildState,
  /** What Docker says, such as `Up 3 minutes` or `Exited (1) 2 seconds ago`. */
  status: z.string(),
  exitCode: z.number().int().nullable(),
  /** Published host ports, as `8080:80/tcp`. */
  ports: z.array(z.string()),
});
export type ComposeContainer = z.infer<typeof composeContainer>;

export const composeChild = z.object({
  name: z.string(),
  state: composeChildState,
  containers: z.array(composeContainer),
});
export type ComposeChild = z.infer<typeof composeChild>;

/** GET /api/v1/projects/{project}/services/{service}/compose/children: live, one row per child. */
export const composeRuntime = z.object({
  children: z.array(composeChild),
  /** The address the proxy reaches a child on, by child. */
  addresses: z.record(z.string(), z.string()),
});
export type ComposeRuntime = z.infer<typeof composeRuntime>;
