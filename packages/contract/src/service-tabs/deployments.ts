import { z } from "zod";
import { actionPage } from "../actions";

/** Every deploy is an Action of this type. */
export const deployActionType = "service.deploy";

/** GET /api/v1/projects/{project}/services/{service}/deployments */
export const listDeploymentsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  cursor: z
    .string()
    .regex(/^\d{1,18}$/, "Invalid cursor")
    .optional(),
});
export type ListDeploymentsQuery = z.infer<typeof listDeploymentsQuery>;

export const deploymentPage = actionPage;
export type DeploymentPage = z.infer<typeof deploymentPage>;

/** The path of a deployment trigger. The token is the only credential a caller needs. */
export const deployTriggerPath = (token: string) => `/api/v1/deploy/${token}`;

/** GET /api/v1/projects/{project}/services/{service}/deployments/trigger */
export const deploymentTrigger = z.object({
  /** Relative to the panel's address, which the browser knows better than the server. */
  path: z.string(),
});
export type DeploymentTrigger = z.infer<typeof deploymentTrigger>;

/** The answer to a delivery that was accepted but deploys nothing. */
export const deployTriggerSkipped = z.object({
  deployed: z.literal(false),
  reason: z.enum(["not_a_push", "branch_deleted", "other_branch"]),
});
export type DeployTriggerSkipped = z.infer<typeof deployTriggerSkipped>;
