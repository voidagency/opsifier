import type {
  ActionDetail,
  ActionEntry,
  ActionPage,
  CallerIdentity,
  DeploymentPage,
  DeployRequest,
  DestroyRequest,
  ListActionsQuery,
  ListDeploymentsQuery,
  LogSearchQuery,
  LogSearchResult,
  ProjectList,
  ProjectSummary,
  ServiceDetail,
} from "@opsifier/contract";
import type { PanelClient } from "./http";

export interface RouteRef {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** As written in the OpenAPI document: what the OpenAPI test checks against the real server. */
  path: string;
}

const SERVICE = "/api/v1/projects/{project}/services/{service}";

/** Every route the dedicated commands and tools use. A test checks each against the real document. */
export const ROUTES = {
  identity: { method: "GET", path: "/api/v1/auth/identity" },
  projects: { method: "GET", path: "/api/v1/projects" },
  project: { method: "GET", path: "/api/v1/projects/{project}" },
  deleteProject: { method: "DELETE", path: "/api/v1/projects/{project}" },
  service: { method: "GET", path: SERVICE },
  destroyService: { method: "DELETE", path: SERVICE },
  deploy: { method: "POST", path: `${SERVICE}/deploy` },
  restart: { method: "POST", path: `${SERVICE}/restart` },
  start: { method: "POST", path: `${SERVICE}/start` },
  stop: { method: "POST", path: `${SERVICE}/stop` },
  logs: { method: "GET", path: `${SERVICE}/logs/search` },
  deployments: { method: "GET", path: `${SERVICE}/deployments` },
  actions: { method: "GET", path: "/api/v1/actions" },
  action: { method: "GET", path: "/api/v1/actions/{id}" },
  cancelAction: { method: "POST", path: "/api/v1/actions/{id}/cancel" },
  openapi: { method: "GET", path: "/api/v1/openapi.json" },
} as const satisfies Record<string, RouteRef>;

export type RouteName = keyof typeof ROUTES;

/** Fills in a route's placeholders. Each value is one path segment, whatever it contains. */
export function fillPath(path: string, params: Record<string, string>): string {
  return path.replace(/\{(\w+)\}/g, (_placeholder, name: string) => encodeURIComponent(params[name] ?? ""));
}

export type ServiceRef = { project: string; service: string };

/** The calls people and agents make most, typed from the contract the server itself is built on. */
export function panelApi(client: PanelClient) {
  const call = <T>(
    route: RouteRef,
    params: Record<string, string> = {},
    options?: Parameters<PanelClient["request"]>[2],
  ) => client.request<T>(route.method, fillPath(route.path, params), options);

  const lifecycle = (route: RouteRef, target: ServiceRef) => call<ActionEntry>(route, target);

  return {
    identity: () => call<CallerIdentity>(ROUTES.identity),
    projects: () => call<ProjectList>(ROUTES.projects),
    project: (project: string) => call<ProjectSummary>(ROUTES.project, { project }),
    deleteProject: (project: string, confirm: string) =>
      call<ActionEntry>(ROUTES.deleteProject, { project }, { body: { confirm } satisfies DestroyRequest }),

    service: (target: ServiceRef) => call<ServiceDetail>(ROUTES.service, target),
    destroyService: (target: ServiceRef, confirm: string) =>
      call<ActionEntry>(ROUTES.destroyService, target, { body: { confirm } satisfies DestroyRequest }),
    deploy: (target: ServiceRef, request: DeployRequest) =>
      call<ActionEntry>(ROUTES.deploy, target, { body: request }),
    restart: (target: ServiceRef) => lifecycle(ROUTES.restart, target),
    start: (target: ServiceRef) => lifecycle(ROUTES.start, target),
    stop: (target: ServiceRef) => lifecycle(ROUTES.stop, target),

    logs: (target: ServiceRef, query: Partial<LogSearchQuery>, signal?: AbortSignal) =>
      call<LogSearchResult>(ROUTES.logs, target, { query, timeoutMs: 120_000, signal }),
    deployments: (target: ServiceRef, query: Partial<ListDeploymentsQuery> = {}) =>
      call<DeploymentPage>(ROUTES.deployments, target, { query }),

    actions: (query: Partial<ListActionsQuery> = {}) => call<ActionPage>(ROUTES.actions, {}, { query }),
    action: (id: string) => call<ActionDetail>(ROUTES.action, { id }),
    cancelAction: (id: string) => call<ActionEntry>(ROUTES.cancelAction, { id }),
  };
}

export type PanelApi = ReturnType<typeof panelApi>;
