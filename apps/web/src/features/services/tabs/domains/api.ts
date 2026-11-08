import {
  type DomainEntry,
  deletedDomain,
  domainEntry,
  exposedPorts,
  type SaveDomainRequest,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { serviceKey } from "../../api";

const base = (project: string, service: string) => `/projects/${project}/services/${service}/domains`;

export const exposedPortsQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "exposed-ports"] as const,
    queryFn: ({ signal }) =>
      api.get(`${base(project, service)}/exposed-ports`, { schema: exposedPorts, signal }),
    staleTime: 0,
  });

export const domainsApi = {
  create: (project: string, service: string, body: SaveDomainRequest) =>
    api.post<DomainEntry>(base(project, service), { body, schema: domainEntry }),
  update: (project: string, service: string, id: string, body: SaveDomainRequest) =>
    api.put<DomainEntry>(`${base(project, service)}/${id}`, { body, schema: domainEntry }),
  remove: (project: string, service: string, id: string) =>
    api.delete(`${base(project, service)}/${id}`, { schema: deletedDomain }),
  makePrimary: (project: string, service: string, id: string) =>
    api.post<DomainEntry>(`${base(project, service)}/${id}/primary`, { schema: domainEntry }),
};
