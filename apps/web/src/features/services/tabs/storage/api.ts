import { type MountSpec, storageDocument } from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { serviceKey } from "../../api";

const path = (project: string, service: string) => `/projects/${project}/services/${service}/storage`;

export const storageQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "storage"] as const,
    queryFn: ({ signal }) => api.get(path(project, service), { schema: storageDocument, signal }),
    staleTime: 0,
  });

export const storageApi = {
  add: (project: string, service: string, body: MountSpec) =>
    api.post(`${path(project, service)}/mounts`, { body, schema: storageDocument }),
  update: (project: string, service: string, index: number, body: MountSpec) =>
    api.put(`${path(project, service)}/mounts/${index}`, { body, schema: storageDocument }),
  remove: (project: string, service: string, index: number) =>
    api.delete(`${path(project, service)}/mounts/${index}`, { schema: storageDocument }),
};
