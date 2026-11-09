import {
  actionEntry,
  type ChangePasswordRequest,
  type CompanionTool,
  type CreateDatabaseRequest,
  companionList,
  type DatabaseSecretName,
  databaseAdvancedSettings,
  databaseAvailability,
  databaseCredentials,
  databaseDetail,
  type ExposeSettings,
  exposeSettings,
  exposeState,
  type ResourcesSpec,
  resourcesSpec,
  revealedCompanionToken,
  revealedSecret,
  type SaveDatabaseAdvancedRequest,
  serviceDetail,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { serviceKey } from "../services/api";

const base = (project: string, service: string) => `/projects/${project}/services/${service}`;

export const databaseQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "database"] as const,
    queryFn: ({ signal }) =>
      api.get(`${base(project, service)}/database`, { schema: databaseDetail, signal }),
    staleTime: 0,
  });

export const databaseAvailabilityQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "database-availability"] as const,
    queryFn: ({ signal }) =>
      api.get(`${base(project, service)}/database/availability`, { schema: databaseAvailability, signal }),
    staleTime: 0,
    refetchInterval: 30_000,
  });

export const credentialsQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "credentials"] as const,
    queryFn: ({ signal }) =>
      api.get(`${base(project, service)}/credentials`, { schema: databaseCredentials, signal }),
    staleTime: 0,
  });

export const exposeQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "expose"] as const,
    queryFn: ({ signal }) => api.get(`${base(project, service)}/expose`, { schema: exposeState, signal }),
    staleTime: 0,
  });

export const databaseResourcesQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "database-resources"] as const,
    queryFn: ({ signal }) =>
      api.get(`${base(project, service)}/database-resources`, { schema: resourcesSpec, signal }),
    staleTime: 0,
  });

export const databaseAdvancedQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "database-advanced"] as const,
    queryFn: ({ signal }) =>
      api.get(`${base(project, service)}/database-advanced`, { schema: databaseAdvancedSettings, signal }),
    staleTime: 0,
  });

export const companionsQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "companions"] as const,
    queryFn: ({ signal }) =>
      api.get(`${base(project, service)}/companions`, { schema: companionList, signal }),
    staleTime: 0,
  });

export const databasesApi = {
  create: (project: string, body: CreateDatabaseRequest) =>
    api.post(`/projects/${project}/databases`, { body, schema: serviceDetail }),
  reveal: (project: string, service: string, secret: DatabaseSecretName) =>
    api.post(`${base(project, service)}/credentials/reveal`, { body: { secret }, schema: revealedSecret }),
  changePassword: (project: string, service: string, body: ChangePasswordRequest) =>
    api.put(`${base(project, service)}/credentials`, { body, schema: actionEntry }),
  checkPassword: (project: string, service: string) =>
    api.post(`${base(project, service)}/credentials/check`, { schema: actionEntry }),
  saveExpose: (project: string, service: string, body: ExposeSettings) =>
    api.put(`${base(project, service)}/expose`, { body, schema: exposeSettings }),
  saveResources: (project: string, service: string, body: ResourcesSpec) =>
    api.put(`${base(project, service)}/database-resources`, { body, schema: resourcesSpec }),
  saveAdvanced: (project: string, service: string, body: SaveDatabaseAdvancedRequest) =>
    api.put(`${base(project, service)}/database-advanced`, { body, schema: databaseAdvancedSettings }),
  enableCompanion: (project: string, service: string, tool: CompanionTool) =>
    api.post(`${base(project, service)}/companions/${tool}`, { schema: actionEntry }),
  disableCompanion: (project: string, service: string, tool: CompanionTool) =>
    api.delete(`${base(project, service)}/companions/${tool}`, { schema: actionEntry }),
  revealCompanionToken: (project: string, service: string, tool: CompanionTool) =>
    api.post(`${base(project, service)}/companions/${tool}/reveal`, { schema: revealedCompanionToken }),
};
