import { type ScriptSpec, scriptList } from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { serviceKey } from "../../api";

const path = (project: string, service: string) => `/projects/${project}/services/${service}/scripts`;

export const scriptsQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "scripts"] as const,
    queryFn: ({ signal }) => api.get(path(project, service), { schema: scriptList, signal }),
    staleTime: 0,
  });

export const scriptsApi = {
  add: (project: string, service: string, body: ScriptSpec) =>
    api.post(path(project, service), { body, schema: scriptList }),
  update: (project: string, service: string, index: number, body: ScriptSpec) =>
    api.put(`${path(project, service)}/${index}`, { body, schema: scriptList }),
  remove: (project: string, service: string, index: number) =>
    api.delete(`${path(project, service)}/${index}`, { schema: scriptList }),
};
