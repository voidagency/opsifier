import {
  deletedRedirect,
  type RedirectRule,
  redirectList,
  redirectRule,
  type SaveRedirectRequest,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { serviceKey } from "../../api";

const base = (project: string, service: string) => `/projects/${project}/services/${service}/redirects`;

export const redirectsQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "redirects"] as const,
    queryFn: ({ signal }) => api.get(base(project, service), { schema: redirectList, signal }),
    staleTime: 0,
  });

export const redirectsApi = {
  create: (project: string, service: string, body: SaveRedirectRequest) =>
    api.post<RedirectRule>(base(project, service), { body, schema: redirectRule }),
  update: (project: string, service: string, id: string, body: SaveRedirectRequest) =>
    api.put<RedirectRule>(`${base(project, service)}/${id}`, { body, schema: redirectRule }),
  remove: (project: string, service: string, id: string) =>
    api.delete(`${base(project, service)}/${id}`, { schema: deletedRedirect }),
};
