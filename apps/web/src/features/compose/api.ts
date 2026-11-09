import {
  type ComposeEnvFileSettings,
  type CreateComposeRequest,
  composeDetail,
  composeRuntime,
  type SaveComposeSourceRequest,
  serviceDetail,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { serviceKey } from "../services/api";

const base = (project: string, service: string) => `/projects/${project}/services/${service}/compose`;

export const composeQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "compose"] as const,
    queryFn: ({ signal }) => api.get(base(project, service), { schema: composeDetail, signal }),
    staleTime: 0,
  });

export const composeRuntimeQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "compose", "children"] as const,
    queryFn: ({ signal }) =>
      api.get(`${base(project, service)}/children`, { schema: composeRuntime, signal }),
    staleTime: 0,
  });

export const composeApi = {
  create: (project: string, body: CreateComposeRequest) =>
    api.post(`/projects/${project}/compose`, { body, schema: serviceDetail }),
  saveSource: (project: string, service: string, body: SaveComposeSourceRequest) =>
    api.put(`${base(project, service)}/source`, { body, schema: composeDetail }),
  acknowledge: (project: string, service: string, content: string) =>
    api.post(`${base(project, service)}/acknowledge`, { body: { content }, schema: composeDetail }),
  setEnvFile: (project: string, service: string, body: ComposeEnvFileSettings) =>
    api.put(`${base(project, service)}/env-file`, { body, schema: composeDetail }),
};
