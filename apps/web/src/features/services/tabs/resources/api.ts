import { type ResourcesSpec, resourcesSpec } from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { serviceKey } from "../../api";

const path = (project: string, service: string) => `/projects/${project}/services/${service}/resources`;

export const resourcesQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "resources"] as const,
    queryFn: ({ signal }) => api.get(path(project, service), { schema: resourcesSpec, signal }),
    staleTime: 0,
  });

export const resourcesApi = {
  save: (project: string, service: string, body: ResourcesSpec) =>
    api.put(path(project, service), { body, schema: resourcesSpec }),
};
