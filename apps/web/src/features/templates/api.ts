import {
  actionEntry,
  type DeployTemplateRequest,
  type InstallTemplateRequest,
  revealedTemplateSecret,
  type TemplateDocument,
  templateCatalogue,
  templateDocument,
  templateInstall,
  templateInstallList,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../lib/api";

export const templatesQuery = queryOptions({
  queryKey: ["templates"] as const,
  queryFn: ({ signal }) => api.get("/templates", { schema: templateCatalogue, signal }),
  staleTime: 5 * 60_000,
});

const base = (project: string) => `/projects/${project}/templates`;

export const installsKey = (project: string) => ["template-installs", project] as const;

export const installsQuery = (project: string) =>
  queryOptions({
    queryKey: installsKey(project),
    queryFn: ({ signal }) => api.get(base(project), { schema: templateInstallList, signal }),
  });

export const installQuery = (project: string, install: string) =>
  queryOptions({
    queryKey: [...installsKey(project), install] as const,
    queryFn: ({ signal }) => api.get(`${base(project)}/${install}`, { schema: templateInstall, signal }),
    staleTime: 0,
  });

export const templatesApi = {
  preview: (schema: string): Promise<TemplateDocument> =>
    api.post("/templates/preview", { body: { schema }, schema: templateDocument }),
  install: (project: string, body: InstallTemplateRequest) =>
    api.post(base(project), { body, schema: templateInstall }),
  deploy: (project: string, install: string, body: DeployTemplateRequest) =>
    api.post(`${base(project)}/${install}/deploy`, { body, schema: actionEntry }),
  remove: (project: string, install: string, confirm: string) =>
    api.delete(`${base(project)}/${install}`, { body: { confirm }, schema: actionEntry }),
  reveal: (project: string, install: string, service: string, name: string) =>
    api.post(`${base(project)}/${install}/secrets/reveal`, {
      body: { service, name },
      schema: revealedTemplateSecret,
    }),
};
