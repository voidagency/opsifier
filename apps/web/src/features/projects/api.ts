import {
  actionEntry,
  type CreateProjectRequest,
  envDocument,
  envSummary,
  projectList,
  projectSchemaDocument,
  projectSummary,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../lib/api";

export const projectsKey = ["projects"] as const;

export const projectsQuery = queryOptions({
  queryKey: projectsKey,
  queryFn: ({ signal }) => api.get("/projects", { schema: projectList, signal }),
});

export const projectQuery = (name: string) =>
  queryOptions({
    queryKey: ["projects", name] as const,
    queryFn: ({ signal }) => api.get(`/projects/${name}`, { schema: projectSummary, signal }),
  });

export const projectEnvQuery = (name: string) =>
  queryOptions({
    queryKey: ["projects", name, "env"] as const,
    queryFn: ({ signal }) => api.get(`/projects/${name}/env`, { schema: envSummary, signal }),
    staleTime: 0,
  });

export const projectSchemaQuery = (name: string) =>
  queryOptions({
    queryKey: ["projects", name, "schema"] as const,
    queryFn: ({ signal }) => api.get(`/projects/${name}/schema`, { schema: projectSchemaDocument, signal }),
    staleTime: 0,
  });

export const projectsApi = {
  create: (body: CreateProjectRequest) => api.post("/projects", { body, schema: projectSummary }),
  saveEnv: (name: string, env: string) =>
    api.put(`/projects/${name}/env`, { body: { env }, schema: envSummary }),
  revealEnv: (name: string) => api.post(`/projects/${name}/env/reveal`, { schema: envDocument }),
  destroy: (name: string, confirm: string) =>
    api.delete(`/projects/${name}`, { body: { confirm }, schema: actionEntry }),
};
