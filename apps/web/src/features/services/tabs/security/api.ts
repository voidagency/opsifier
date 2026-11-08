import {
  type BasicAuthEntry,
  basicAuthEntry,
  basicAuthList,
  type CreateBasicAuthRequest,
  deletedBasicAuth,
  type UpdateBasicAuthRequest,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { serviceKey } from "../../api";

const base = (project: string, service: string) => `/projects/${project}/services/${service}/basic-auth`;

export const basicAuthQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "basic-auth"] as const,
    queryFn: ({ signal }) => api.get(base(project, service), { schema: basicAuthList, signal }),
    staleTime: 0,
  });

export const basicAuthApi = {
  create: (project: string, service: string, body: CreateBasicAuthRequest) =>
    api.post<BasicAuthEntry>(base(project, service), { body, schema: basicAuthEntry }),
  update: (project: string, service: string, id: string, body: UpdateBasicAuthRequest) =>
    api.put<BasicAuthEntry>(`${base(project, service)}/${id}`, { body, schema: basicAuthEntry }),
  remove: (project: string, service: string, id: string) =>
    api.delete(`${base(project, service)}/${id}`, { schema: deletedBasicAuth }),
};
