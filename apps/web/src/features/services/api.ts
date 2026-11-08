import {
  type ActionEntry,
  actionEntry,
  actionsTopic,
  type CreateServiceRequest,
  deploymentPage,
  deploymentTrigger,
  domainList,
  type RenameServiceRequest,
  type SaveSourceRequest,
  type ServiceDetail,
  type ServiceStatus,
  serviceDetail,
  serviceEnvironment,
  serviceMetrics,
  serviceNotes,
  serviceSource,
} from "@opsifier/contract";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api } from "../../lib/api";
import { useTopic } from "../../lib/realtime";
import type { LampStatus } from "../../ui";
import { projectsKey } from "../projects/api";

/** The project and service the current route is about. Only for components under a service route. */
export function useServiceParams(): { project: string; service: string } {
  return useParams({ strict: false }) as { project: string; service: string };
}

const base = (project: string, service: string) => `/projects/${project}/services/${service}`;

export const serviceKey = (project: string, service: string) => ["services", project, service] as const;

export const serviceQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: serviceKey(project, service),
    queryFn: ({ signal }) => api.get(base(project, service), { schema: serviceDetail, signal }),
    staleTime: 0,
  });

export const metricsQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "metrics"] as const,
    queryFn: ({ signal }) => api.get(`${base(project, service)}/metrics`, { schema: serviceMetrics, signal }),
    staleTime: 0,
  });

export const environmentQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "environment"] as const,
    queryFn: ({ signal }) =>
      api.get(`${base(project, service)}/environment`, { schema: serviceEnvironment, signal }),
    staleTime: 0,
  });

export const domainsQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "domains"] as const,
    queryFn: ({ signal }) => api.get(`${base(project, service)}/domains`, { schema: domainList, signal }),
  });

export const deploymentsQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "deployments"] as const,
    queryFn: ({ signal }) =>
      api.get(`${base(project, service)}/deployments`, { schema: deploymentPage, signal }),
    staleTime: 0,
  });

export const triggerQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "trigger"] as const,
    queryFn: ({ signal }) =>
      api.get(`${base(project, service)}/deployments/trigger`, { schema: deploymentTrigger, signal }),
  });

export const servicesApi = {
  create: (project: string, body: CreateServiceRequest) =>
    api.post(`/projects/${project}/services`, { body, schema: serviceDetail }),
  deploy: (project: string, service: string, options: { force?: boolean } = {}) =>
    api.post(`${base(project, service)}/deploy`, {
      ...(options.force ? { body: { force: true } } : {}),
      schema: actionEntry,
    }),
  stop: (project: string, service: string) =>
    api.post(`${base(project, service)}/stop`, { schema: actionEntry }),
  start: (project: string, service: string) =>
    api.post(`${base(project, service)}/start`, { schema: actionEntry }),
  restart: (project: string, service: string) =>
    api.post(`${base(project, service)}/restart`, { schema: actionEntry }),
  destroy: (project: string, service: string, confirm: string) =>
    api.delete(base(project, service), { body: { confirm }, schema: actionEntry }),
  rename: (project: string, service: string, body: RenameServiceRequest) =>
    api.post(`${base(project, service)}/rename`, { body, schema: serviceDetail }),
  saveNotes: (project: string, service: string, notes: string) =>
    api.put(`${base(project, service)}/notes`, { body: { notes }, schema: serviceNotes }),
  saveSource: (project: string, service: string, body: SaveSourceRequest) =>
    api.put(`${base(project, service)}/source`, { body, schema: serviceSource }),
  rotateTrigger: (project: string, service: string) =>
    api.post(`${base(project, service)}/deployments/trigger/rotate`, { schema: deploymentTrigger }),
  saveEnvironment: (project: string, service: string, env: string) =>
    api.put(`${base(project, service)}/environment`, { body: { env }, schema: serviceEnvironment }),
};

export function isActive(action: Pick<ActionEntry, "status">): boolean {
  return action.status === "queued" || action.status === "running";
}

/** What the lamp shows. Work in progress overrides the running state, because that is what's happening. */
export function lampForService(
  status: ServiceStatus,
  activeAction: ServiceDetail["activeAction"],
): LampStatus {
  if (activeAction !== null) {
    return "busy";
  }
  switch (status) {
    case "running":
      return "ok";
    case "starting":
      return "busy";
    case "failing":
      return "bad";
    default:
      return "off";
  }
}

export const statusLabelKey = (status: ServiceStatus): `status.${ServiceStatus}` => `status.${status}`;

/**
 * Refetches everything an Action can have changed the moment one starts or finishes, so nothing
 * on screen, spinners included, outlives the work it was showing. Mounted once, by the shell.
 */
export function useLiveServiceData(): void {
  const queryClient = useQueryClient();
  useTopic<ActionEntry>(actionsTopic, (action) => {
    void queryClient.invalidateQueries({ queryKey: projectsKey });
    if (action.projectName !== null && action.serviceName !== null) {
      void queryClient.invalidateQueries({ queryKey: serviceKey(action.projectName, action.serviceName) });
    }
  });
}
