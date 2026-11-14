import type {
  ActionDetail,
  ActionEntry,
  ActionPage,
  BackupsDocument,
  CallerIdentity,
  CliLoginCollect,
  CliLoginSession,
  CliLoginStart,
  CliLoginStarted,
  CreateDatabaseRequest,
  CreatedInvitations,
  CreateInvitationsRequest,
  CreateProjectRequest,
  CreateServiceRequest,
  DatabaseCredentials,
  DatabaseSecretName,
  DeploymentPage,
  DeployRequest,
  DestroyRequest,
  DomainEntry,
  DomainList,
  EnvDocument,
  EnvSummary,
  ListActionsQuery,
  ListDeploymentsQuery,
  LogSearchQuery,
  LogSearchResult,
  MaintenanceSettings,
  MaintenanceSettingsInput,
  PanelUser,
  ProjectList,
  ProjectSummary,
  ReleaseList,
  RevealedSecret,
  RevealSecretRequest,
  RollbackRequest,
  SaveDomainRequest,
  SaveSourceRequest,
  ScriptList,
  ScriptRun,
  ScriptRunDetail,
  ServiceDefinitionRequest,
  ServiceDetail,
  ServiceEnvironment,
  ServiceMetrics,
  ServiceSource,
  SourceSettings,
  StartScriptRunRequest,
  UpdateUserRequest,
  UserList,
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
  createProject: { method: "POST", path: "/api/v1/projects" },
  project: { method: "GET", path: "/api/v1/projects/{project}" },
  createService: { method: "POST", path: "/api/v1/projects/{project}/services" },
  createDatabase: { method: "POST", path: "/api/v1/projects/{project}/databases" },
  defineService: { method: "POST", path: "/api/v1/projects/{project}/services/definition" },
  deleteProject: { method: "DELETE", path: "/api/v1/projects/{project}" },
  service: { method: "GET", path: SERVICE },
  destroyService: { method: "DELETE", path: SERVICE },
  deploy: { method: "POST", path: `${SERVICE}/deploy` },
  restart: { method: "POST", path: `${SERVICE}/restart` },
  start: { method: "POST", path: `${SERVICE}/start` },
  stop: { method: "POST", path: `${SERVICE}/stop` },
  logs: { method: "GET", path: `${SERVICE}/logs/search` },
  deployments: { method: "GET", path: `${SERVICE}/deployments` },
  source: { method: "GET", path: `${SERVICE}/source` },
  saveSource: { method: "PUT", path: `${SERVICE}/source` },
  uploadSource: { method: "PUT", path: `${SERVICE}/source/upload` },
  domains: { method: "GET", path: `${SERVICE}/domains` },
  addDomain: { method: "POST", path: `${SERVICE}/domains` },
  removeDomain: { method: "DELETE", path: `${SERVICE}/domains/{domain}` },
  primaryDomain: { method: "POST", path: `${SERVICE}/domains/{domain}/primary` },
  maintenance: { method: "GET", path: `${SERVICE}/maintenance` },
  saveMaintenance: { method: "PUT", path: `${SERVICE}/maintenance` },
  credentials: { method: "GET", path: `${SERVICE}/credentials` },
  revealCredential: { method: "POST", path: `${SERVICE}/credentials/reveal` },
  scripts: { method: "GET", path: `${SERVICE}/scripts` },
  addScript: { method: "POST", path: `${SERVICE}/scripts` },
  removeScript: { method: "DELETE", path: `${SERVICE}/scripts/{index}` },
  runScript: { method: "POST", path: `${SERVICE}/script-runs` },
  scriptRun: { method: "GET", path: `${SERVICE}/script-runs/{id}` },
  backups: { method: "GET", path: `${SERVICE}/backups` },
  runBackup: { method: "POST", path: `${SERVICE}/backups/configs/{config}/run` },
  metrics: { method: "GET", path: `${SERVICE}/metrics` },
  releases: { method: "GET", path: `${SERVICE}/releases` },
  rollback: { method: "POST", path: `${SERVICE}/releases/{number}/rollback` },
  serviceEnv: { method: "GET", path: `${SERVICE}/environment` },
  saveServiceEnv: { method: "PUT", path: `${SERVICE}/environment` },
  revealServiceEnv: { method: "POST", path: `${SERVICE}/environment/reveal` },
  projectEnv: { method: "GET", path: "/api/v1/projects/{project}/env" },
  saveProjectEnv: { method: "PUT", path: "/api/v1/projects/{project}/env" },
  revealProjectEnv: { method: "POST", path: "/api/v1/projects/{project}/env/reveal" },
  actions: { method: "GET", path: "/api/v1/actions" },
  action: { method: "GET", path: "/api/v1/actions/{id}" },
  cancelAction: { method: "POST", path: "/api/v1/actions/{id}/cancel" },
  openapi: { method: "GET", path: "/api/v1/openapi.json" },
  logout: { method: "POST", path: "/api/v1/auth/logout" },
  cliLoginStart: { method: "POST", path: "/api/v1/auth/cli/start" },
  cliLoginToken: { method: "POST", path: "/api/v1/auth/cli/token" },
  users: { method: "GET", path: "/api/v1/users" },
  updateUser: { method: "PUT", path: "/api/v1/users/{user}" },
  setUserActive: { method: "POST", path: "/api/v1/users/{user}/active" },
  inviteUsers: { method: "POST", path: "/api/v1/users/invitations" },
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
    createProject: (name: string) =>
      call<ProjectSummary>(ROUTES.createProject, {}, { body: { name } satisfies CreateProjectRequest }),
    project: (project: string) => call<ProjectSummary>(ROUTES.project, { project }),
    createService: (target: ServiceRef) =>
      call<ServiceDetail>(
        ROUTES.createService,
        { project: target.project },
        { body: { name: target.service, type: "app" } satisfies CreateServiceRequest },
      ),
    /** A service with its source in one request: the panel leaves nothing behind when it refuses it. */
    defineService: (target: ServiceRef, source: SaveSourceRequest) =>
      call<ServiceDetail>(
        ROUTES.defineService,
        { project: target.project },
        { body: { name: target.service, source } satisfies ServiceDefinitionRequest },
      ),
    createDatabase: (target: ServiceRef, engine: CreateDatabaseRequest["engine"]) =>
      call<ServiceDetail>(
        ROUTES.createDatabase,
        { project: target.project },
        { body: { name: target.service, engine } },
      ),

    source: (target: ServiceRef) => call<SourceSettings>(ROUTES.source, target),
    saveSource: (target: ServiceRef, source: SaveSourceRequest) =>
      call<ServiceSource>(ROUTES.saveSource, target, { body: source }),
    /** The archive goes as it is. The panel unpacks and builds it at the next deploy. */
    uploadSource: (
      target: ServiceRef,
      archive: Uint8Array,
      query: { fileName: string; path: string },
      signal?: AbortSignal,
    ) =>
      call<ServiceSource>(ROUTES.uploadSource, target, {
        query,
        raw: { body: archive, contentType: "application/octet-stream" },
        timeoutMs: 15 * 60_000,
        signal,
      }),
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
    domains: (target: ServiceRef) => call<DomainList>(ROUTES.domains, target),
    addDomain: (target: ServiceRef, domain: SaveDomainRequest) =>
      call<DomainEntry>(ROUTES.addDomain, target, { body: domain }),
    removeDomain: (target: ServiceRef, domain: string) =>
      call<{ id: string }>(ROUTES.removeDomain, { ...target, domain }),
    primaryDomain: (target: ServiceRef, domain: string) =>
      call<DomainEntry>(ROUTES.primaryDomain, { ...target, domain }),
    maintenance: (target: ServiceRef) => call<MaintenanceSettings>(ROUTES.maintenance, target),
    saveMaintenance: (target: ServiceRef, settings: MaintenanceSettingsInput) =>
      call<MaintenanceSettings>(ROUTES.saveMaintenance, target, { body: settings }),
    credentials: (target: ServiceRef) => call<DatabaseCredentials>(ROUTES.credentials, target),
    /** One secret per call, which the panel records in its activity log. */
    revealCredential: (target: ServiceRef, secret: DatabaseSecretName) =>
      call<RevealedSecret>(ROUTES.revealCredential, target, {
        body: { secret } satisfies RevealSecretRequest,
      }),
    scripts: (target: ServiceRef) => call<ScriptList>(ROUTES.scripts, target),
    addScript: (
      target: ServiceRef,
      script: {
        name: string;
        script: string;
        runAfterDeploy?: boolean;
        schedule?: { cron: string; timeZone: string };
      },
    ) => call<ScriptList>(ROUTES.addScript, target, { body: script }),
    removeScript: (target: ServiceRef, index: number) =>
      call<ScriptList>(ROUTES.removeScript, { ...target, index: String(index) }),
    runScript: (target: ServiceRef, script: string) =>
      call<ActionEntry & { run: ScriptRun }>(ROUTES.runScript, target, {
        body: { script } satisfies StartScriptRunRequest,
      }),
    scriptRun: (target: ServiceRef, id: string, signal?: AbortSignal) =>
      call<ScriptRunDetail>(ROUTES.scriptRun, { ...target, id }, { signal }),
    backups: (target: ServiceRef) => call<BackupsDocument>(ROUTES.backups, target),
    runBackup: (target: ServiceRef, config: string) =>
      call<ActionEntry>(ROUTES.runBackup, { ...target, config }, { body: {} }),
    metrics: (target: ServiceRef) => call<ServiceMetrics>(ROUTES.metrics, target),
    releases: (target: ServiceRef) => call<ReleaseList>(ROUTES.releases, target),
    rollback: (target: ServiceRef, number: number, confirm: string) =>
      call<ActionEntry>(
        ROUTES.rollback,
        { ...target, number: String(number) },
        { body: { confirm } satisfies RollbackRequest },
      ),

    /** Names only. The values come from the reveal calls, which the panel records in its activity log. */
    serviceEnv: (target: ServiceRef) => call<ServiceEnvironment>(ROUTES.serviceEnv, target),
    saveServiceEnv: (target: ServiceRef, env: string) =>
      call<ServiceEnvironment>(ROUTES.saveServiceEnv, target, { body: { env } satisfies EnvDocument }),
    revealServiceEnv: (target: ServiceRef) => call<EnvDocument>(ROUTES.revealServiceEnv, target),
    projectEnv: (project: string) => call<EnvSummary>(ROUTES.projectEnv, { project }),
    saveProjectEnv: (project: string, env: string) =>
      call<EnvSummary>(ROUTES.saveProjectEnv, { project }, { body: { env } satisfies EnvDocument }),
    revealProjectEnv: (project: string) => call<EnvDocument>(ROUTES.revealProjectEnv, { project }),

    actions: (query: Partial<ListActionsQuery> = {}) => call<ActionPage>(ROUTES.actions, {}, { query }),
    action: (id: string, signal?: AbortSignal) => call<ActionDetail>(ROUTES.action, { id }, { signal }),
    cancelAction: (id: string) => call<ActionEntry>(ROUTES.cancelAction, { id }),

    /** Ends the session the call is made with: a person's session from `opsifier login --web`. */
    logout: () => call<unknown>(ROUTES.logout),
    /** Unauthenticated: asks to sign the command line in as a person, approved in a browser. */
    startCliLogin: (client: string) =>
      call<CliLoginStarted>(ROUTES.cliLoginStart, {}, { body: { client } satisfies CliLoginStart }),
    /** Unauthenticated: the session once approved, `{ status: "pending" }` until then. */
    collectCliLogin: (deviceCode: string) =>
      call<CliLoginSession | { status: "pending" }>(
        ROUTES.cliLoginToken,
        {},
        { body: { deviceCode } satisfies CliLoginCollect },
      ),

    /** Accounts: a person's session only, never an API key. */
    users: () => call<UserList>(ROUTES.users),
    updateUser: (user: string, body: UpdateUserRequest) =>
      call<PanelUser>(ROUTES.updateUser, { user }, { body }),
    setUserActive: (user: string, active: boolean) =>
      call<PanelUser>(ROUTES.setUserActive, { user }, { body: { active } }),
    inviteUsers: (body: CreateInvitationsRequest) =>
      call<CreatedInvitations>(ROUTES.inviteUsers, {}, { body }),
  };
}

export type PanelApi = ReturnType<typeof panelApi>;
