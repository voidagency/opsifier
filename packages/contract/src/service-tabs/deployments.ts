import { z } from "zod";
import { actionEntry } from "../actions";
import { wholeNumber } from "../common";
import { servicePath } from "../services";

/** Every deploy is an Action of this type. */
export const deployActionType = "service.deploy";

/** Going back to a kept version. It is a deployment in every respect but where its image comes from. */
export const rollbackActionType = "service.rollback";

/** The Actions a service's history lists: each one is an attempt to put something new in place. */
export const deploymentActionTypes: readonly string[] = [deployActionType, rollbackActionType];

export const isDeploymentAction = (type: string): boolean => deploymentActionTypes.includes(type);

/** GET /api/v1/projects/{project}/services/{service}/deployments */
export const listDeploymentsQuery = z.object({
  limit: wholeNumber(1, 100).default(10),
  cursor: z
    .string()
    .regex(/^\d{1,18}$/, "Invalid cursor")
    .optional(),
});
export type ListDeploymentsQuery = z.infer<typeof listDeploymentsQuery>;

/** What one deployment asked for and what it really put in place. Unknown is null, never guessed. */
export const deploymentRecord = z.object({
  /** The branch, tag or commit it was asked to build. Null for a source that has none. */
  requestedRef: z.string().nullable(),
  /** The commit it actually fetched and built. */
  builtCommit: z.string().nullable(),
  /** The revision read back from the built image's own label. */
  ociRevision: z.string().nullable(),
  /** The image's name as asked for: what is saved, or the tag a build produced. */
  image: z.string().nullable(),
  /** The exact local image, `sha256:...`: no tag or registry can make it mean anything else. */
  imageId: z.string().nullable(),
  /** `repository@sha256:...`, for an image that came from a registry. */
  digest: z.string().nullable(),
  /** The version this deployment kept, once it has succeeded. */
  release: z.number().int().nullable(),
  /** On a rollback: the version it went back to. */
  rollbackOf: z.number().int().nullable(),
  /** Whether it answered on its port at the end. Null when that could not be told. */
  answering: z.boolean().nullable(),
  /** Tasks up when it finished, read from Docker, against how many were wanted. */
  runningTasks: z.number().int().min(0).nullable(),
  desiredTasks: z.number().int().min(0).nullable(),
});
export type DeploymentRecord = z.infer<typeof deploymentRecord>;

/** One attempt in a service's history. */
export const deploymentEntry = actionEntry.extend({ deployment: deploymentRecord.nullable() });
export type DeploymentEntry = z.infer<typeof deploymentEntry>;

export const deploymentPage = z.object({
  items: z.array(deploymentEntry),
  /** Pass as `cursor` to load the next page. Null when there is nothing more. */
  nextCursor: z.string().nullable(),
});
export type DeploymentPage = z.infer<typeof deploymentPage>;

/** What part of a service a difference is about, which is also what is drawn beside it. */
export const configChangeArea = z.enum([
  "image",
  "source",
  "build",
  "environment",
  "command",
  "resources",
  "replicas",
  "volumes",
  "files",
  "ports",
  "compose",
  "advanced",
]);
export type ConfigChangeArea = z.infer<typeof configChangeArea>;

/**
 * One difference between two configurations. Variables and file contents are named and never quoted,
 * since what they hold can be a secret.
 */
export const configChange = z.object({
  area: configChangeArea,
  /** A variable, a path, a port: what the difference is about. Empty when the area says it all. */
  name: z.string(),
  kind: z.enum(["added", "removed", "changed"]),
  /** What is in place now. */
  before: z.string().nullable(),
  /** What it would become. */
  after: z.string().nullable(),
});
export type ConfigChange = z.infer<typeof configChange>;

/** GET .../deployments/pending: what is saved against what runs. */
export const pendingChanges = z.object({
  /** False until a deployment has recorded what it applied: there is nothing to compare yet. */
  known: z.boolean(),
  changes: z.array(configChange),
  /** What the next deployment fetches anew, whatever is saved: a tag or a branch may have moved. */
  refetches: z.enum(["image", "code", "stack"]).nullable(),
});
export type PendingChanges = z.infer<typeof pendingChanges>;

/** How many versions a server keeps of each service, within what an owner can ask for. */
export const DEFAULT_RELEASES_KEPT = 5;
export const MAX_RELEASES_KEPT = 50;

/** Why a kept version can't be gone back to. */
export const releaseRefusal = z.enum([
  "active",
  "not_deployed",
  "renamed",
  "image_missing",
  "image_altered",
  "volumes_differ",
]);
export type ReleaseRefusal = z.infer<typeof releaseRefusal>;

/** A kept version. Only ever metadata: its configuration stays sealed on the server. */
export const releaseEntry = z.object({
  number: z.number().int().min(1),
  /** The version that is running, as far as the panel can vouch for it. */
  active: z.boolean(),
  /** The image's name as it was asked for. */
  image: z.string(),
  imageId: z.string(),
  digest: z.string().nullable(),
  sizeBytes: z.number().min(0).nullable(),
  requestedRef: z.string().nullable(),
  builtCommit: z.string().nullable(),
  ociRevision: z.string().nullable(),
  /** Set when this version is itself a rollback: the version it went back to. */
  rollbackOf: z.number().int().nullable(),
  actorEmail: z.string().nullable(),
  /** The Action that made it, for as long as that is remembered. */
  actionId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** Null when it can be gone back to. */
  refusal: releaseRefusal.nullable(),
});
export type ReleaseEntry = z.infer<typeof releaseEntry>;

/** GET .../releases */
export const releaseList = z.object({
  /** False for what has no versions: Compose stacks, databases, a service never deployed since they began. */
  available: z.boolean(),
  items: z.array(releaseEntry),
  /** How many of the newest versions each service keeps on this server. */
  keep: z.number().int().min(1),
});
export type ReleaseList = z.infer<typeof releaseList>;

/** GET .../releases/{number}: what going back to it would change. */
export const releaseDetail = releaseEntry.extend({ changes: z.array(configChange) });
export type ReleaseDetail = z.infer<typeof releaseDetail>;

export const releasePath = servicePath.extend({ number: wholeNumber(1, 2 ** 31) });

/** POST .../releases/{number}/rollback. `confirm` is the service's exact name. */
export const rollbackRequest = z.object({ confirm: z.string() });
export type RollbackRequest = z.infer<typeof rollbackRequest>;

/** Where a CI job POSTs, with the service's token in an `Authorization: Bearer` header. */
export const DEPLOY_TRIGGER_PATH = "/api/v1/deploy";

/** Where a Git host delivers a push webhook. The id names the webhook and proves nothing. */
export const webhookDeliveryPath = (id: string) => `/api/v1/deploy/hook/${id}`;

/** A push webhook, without its secret. */
export const deploymentWebhook = z.object({
  /** Relative to the panel's address, which the browser knows better than the server. */
  path: z.string(),
  /** Created on GitHub by the panel, as opposed to configured by hand at the Git host. */
  managed: z.boolean(),
  /** The repository and branch it was issued for. Only pushes to these deploy. */
  repository: z.string(),
  ref: z.string(),
  /** The repository or branch changed since: deliveries are refused until the secret is rotated. */
  paused: z.boolean(),
  /** From before webhooks had their own secret: it still calls the old URL, signed with the old token. */
  legacy: z.boolean(),
  createdAt: z.iso.datetime().nullable(),
});
export type DeploymentWebhook = z.infer<typeof deploymentWebhook>;

/** GET /api/v1/projects/{project}/services/{service}/deployments/trigger. Holds no secret. */
export const deploymentTrigger = z.object({
  /** Relative to the panel's address, which the browser knows better than the server. */
  path: z.string(),
  hasToken: z.boolean(),
  /** A token from before tokens moved to a header: still accepted in the URL until it is replaced. */
  legacyUrl: z.boolean(),
  createdAt: z.iso.datetime().nullable(),
  webhook: deploymentWebhook.nullable(),
  /** Whether this service builds from a repository a webhook could watch. */
  webhookAvailable: z.boolean(),
});
export type DeploymentTrigger = z.infer<typeof deploymentTrigger>;

/** POST .../deployments/trigger/rotate. The only moment the token can be read, by anyone. */
export const issuedDeploymentTrigger = deploymentTrigger.extend({ token: z.string() });
export type IssuedDeploymentTrigger = z.infer<typeof issuedDeploymentTrigger>;

/** POST .../deployments/webhook/rotate. The secret is null when the panel installed it on GitHub itself. */
export const issuedDeploymentWebhook = z.object({
  webhook: deploymentWebhook,
  secret: z.string().nullable(),
});
export type IssuedDeploymentWebhook = z.infer<typeof issuedDeploymentWebhook>;

/** The answer to a delivery that was accepted but deploys nothing. */
export const deployTriggerSkipped = z.object({
  deployed: z.literal(false),
  reason: z.enum([
    "not_a_push",
    "no_repository",
    "other_repository",
    "branch_deleted",
    "other_branch",
    "duplicate",
  ]),
  /** The Action an earlier copy of this delivery started. */
  actionId: z.string().optional(),
});
export type DeployTriggerSkipped = z.infer<typeof deployTriggerSkipped>;
