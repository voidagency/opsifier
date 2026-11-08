import {
  advancedDocument,
  type DeploySettings,
  deploySettings,
  type PortSpec,
  portList,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { serviceKey } from "../../api";

const path = (project: string, service: string) => `/projects/${project}/services/${service}/advanced`;

export const advancedQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "advanced"] as const,
    queryFn: ({ signal }) => api.get(path(project, service), { schema: advancedDocument, signal }),
    staleTime: 0,
  });

export const advancedApi = {
  saveDeploy: (project: string, service: string, body: DeploySettings) =>
    api.put(`${path(project, service)}/deploy`, { body, schema: deploySettings }),
  addPort: (project: string, service: string, body: PortSpec) =>
    api.post(`${path(project, service)}/ports`, { body, schema: portList }),
  updatePort: (project: string, service: string, index: number, body: PortSpec) =>
    api.put(`${path(project, service)}/ports/${index}`, { body, schema: portList }),
  removePort: (project: string, service: string, index: number) =>
    api.delete(`${path(project, service)}/ports/${index}`, { schema: portList }),
  removeAllPorts: (project: string, service: string) =>
    api.delete(`${path(project, service)}/ports`, { schema: portList }),
};
