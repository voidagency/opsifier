import { z } from "zod";
import { projectName } from "./common";
import { serviceSource } from "./service-tabs/source";
import { serviceSummary } from "./services";

export const projectPath = z.object({ project: projectName });

/** POST /api/v1/projects */
export const createProjectRequest = z.object({ name: projectName });
export type CreateProjectRequest = z.infer<typeof createProjectRequest>;

/** One project and its services. Environment variables are fetched separately. */
export const projectSummary = z.object({
  name: z.string(),
  createdAt: z.iso.datetime(),
  services: z.array(serviceSummary),
});
export type ProjectSummary = z.infer<typeof projectSummary>;

/** GET /api/v1/projects */
export const projectList = z.object({ projects: z.array(projectSummary) });
export type ProjectList = z.infer<typeof projectList>;

/** The body of a destructive request: the name, typed again and checked on the server. */
export const destroyRequest = z.object({ confirm: z.string().min(1, "Required") });
export type DestroyRequest = z.infer<typeof destroyRequest>;

/** GET /api/v1/projects/{project}/schema: a portable description, with every secret left out. */
export const projectSchemaDocument = z.object({
  services: z.array(
    z.object({
      type: z.string(),
      data: z.object({
        projectName: z.string(),
        serviceName: z.string(),
        source: z
          .union([
            z.object({ type: z.literal("image"), image: z.string(), username: z.string().nullable() }),
            serviceSource,
          ])
          .nullable(),
        deploy: z.object({
          command: z.string().nullable(),
          replicas: z.number().int(),
          zeroDowntime: z.boolean(),
        }),
        domains: z.array(
          z.object({
            host: z.string(),
            https: z.boolean(),
            path: z.string(),
            port: z.number().int(),
            internalProtocol: z.string(),
            middlewares: z.array(z.string()),
            certificateResolver: z.string(),
            wildcard: z.boolean(),
          }),
        ),
      }),
    }),
  ),
});
export type ProjectSchemaDocument = z.infer<typeof projectSchemaDocument>;
