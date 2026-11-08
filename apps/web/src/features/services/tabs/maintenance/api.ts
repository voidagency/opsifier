import {
  type MaintenanceSettings,
  type MaintenanceSettingsInput,
  maintenanceSettings,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { serviceKey } from "../../api";

const base = (project: string, service: string) => `/projects/${project}/services/${service}/maintenance`;

export const maintenanceQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "maintenance"] as const,
    queryFn: ({ signal }) => api.get(base(project, service), { schema: maintenanceSettings, signal }),
    staleTime: 0,
  });

export const maintenanceApi = {
  save: (project: string, service: string, body: MaintenanceSettingsInput) =>
    api.put<MaintenanceSettings>(base(project, service), { body, schema: maintenanceSettings }),
};
