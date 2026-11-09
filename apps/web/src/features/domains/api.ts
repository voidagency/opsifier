import {
  domainsOverview,
  overviewDomain,
  type SaveCustomDomainRequest,
  type SaveDomainRequest,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../lib/api";

export const domainsOverviewKey = ["domains"] as const;

export const domainsOverviewQuery = queryOptions({
  queryKey: ["domains", "overview"] as const,
  queryFn: ({ signal }) => api.get("/domains", { schema: domainsOverview, signal }),
  refetchInterval: 15_000,
});

export const overviewApi = {
  createCustom: (body: SaveCustomDomainRequest) =>
    api.post("/domains/custom", { body, schema: overviewDomain }),
  updateCustom: (id: string, body: SaveCustomDomainRequest) =>
    api.put(`/domains/custom/${id}`, { body, schema: overviewDomain }),
  deleteCustom: (id: string) => api.delete(`/domains/custom/${id}`),
  createService: (project: string, service: string, body: SaveDomainRequest) =>
    api.post(`/projects/${project}/services/${service}/domains`, { body }),
  updateService: (project: string, service: string, id: string, body: SaveDomainRequest) =>
    api.put(`/projects/${project}/services/${service}/domains/${id}`, { body }),
  deleteService: (project: string, service: string, id: string) =>
    api.delete(`/projects/${project}/services/${service}/domains/${id}`),
};
