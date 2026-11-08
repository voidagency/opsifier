import { z } from "zod";
import { projectName, resourceName } from "./common";
import { serviceSource } from "./service-tabs/source";

export const servicePath = z.object({ project: projectName, service: resourceName });

export const serviceType = z.enum(["app"]);
export type ServiceType = z.infer<typeof serviceType>;

/**
 * What the status lamp shows. `undeployed` has never run, `stopped` was stopped on purpose,
 * `failing` has desired tasks it cannot keep running, and `unknown` means Docker did not answer.
 */
export const serviceStatus = z.enum(["undeployed", "stopped", "starting", "running", "failing", "unknown"]);
export type ServiceStatus = z.infer<typeof serviceStatus>;

/** The result of one deployment, as drawn in the wake strip. */
export const deployOutcome = z.enum(["succeeded", "failed", "running", "cancelled"]);
export type DeployOutcome = z.infer<typeof deployOutcome>;

/** The work in progress on a service, so the UI can follow it and never outlive it. */
export const activeAction = z.object({ id: z.string(), type: z.string() });
export type ActiveAction = z.infer<typeof activeAction>;

/** One row of the project page and of Overview. */
export const serviceSummary = z.object({
  projectName: z.string(),
  name: z.string(),
  type: z.string(),
  status: serviceStatus,
  replicas: z.object({ running: z.number().int().min(0), desired: z.number().int().min(0) }),
  activeAction: activeAction.nullable(),
  /** The last 24 deployments, oldest first. */
  wake: z.array(deployOutcome).max(24),
  lastDeployedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ServiceSummary = z.infer<typeof serviceSummary>;

/** POST /api/v1/projects/{project}/services */
export const createServiceRequest = z.object({
  name: resourceName,
  type: serviceType.default("app"),
});
export type CreateServiceRequest = z.infer<typeof createServiceRequest>;

/** GET /api/v1/projects/{project}/services/{service} */
export const serviceDetail = serviceSummary.extend({
  /** Null until a source is saved: the service is still being set up. */
  source: serviceSource.nullable(),
  notes: z.string(),
  stopped: z.boolean(),
  primaryUrl: z.string().nullable(),
});
export type ServiceDetail = z.infer<typeof serviceDetail>;

/** POST /api/v1/projects/{project}/services/{service}/rename */
export const renameServiceRequest = z.object({
  projectName,
  name: resourceName,
});
export type RenameServiceRequest = z.infer<typeof renameServiceRequest>;

/** POST /api/v1/projects/{project}/services/{service}/deploy */
export const deployRequest = z.object({
  /** Skip every build cache. Image sources have none, so it changes nothing for them. */
  force: z.boolean().default(false),
});
export type DeployRequest = z.infer<typeof deployRequest>;
