import {
  type ActionEntry,
  actionEntry,
  apiKeyList,
  type CreateApiKeyRequest,
  type CreateUserRequest,
  certificateList,
  cleanupPreview,
  createdApiKey,
  type DockerCleanupKind,
  diskUsageListing,
  dockerUpdateCheck,
  letsEncryptEmail,
  type MonitoringSettings,
  monitoringOverview,
  notificationChannel,
  notificationChannelList,
  notificationDeliveryList,
  panelDomainSettings,
  panelUser,
  proxyCustomConfig,
  proxyDashboard,
  proxyDashboardStatus,
  proxyEnvironment,
  proxyEnvironmentSummary,
  type RevealServerBackupKeyRequest,
  type SaveNotificationChannelRequest,
  type SavePanelDomainRequest,
  type SaveServerBackupRequest,
  type SaveServiceDomainRequest,
  serverBackupKey,
  serverBackupSaved,
  serverBackupSnapshots,
  serverBackupState,
  serverOverview,
  serviceDomainSettings,
  type TestNotificationRequest,
  type TrustedProxiesSettings,
  type TwoFactorPolicy,
  testNotificationResult,
  trustedProxiesSettings,
  twoFactorPolicyState,
  type UpdateUserRequest,
  userList,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../../lib/api";

export const serverKey = ["server"] as const;

export const serverOverviewQuery = queryOptions({
  queryKey: ["server", "overview"] as const,
  queryFn: ({ signal }) => api.get("/server/overview", { schema: serverOverview, signal }),
  refetchInterval: 30_000,
});

export const panelDomainQuery = queryOptions({
  queryKey: ["server", "panel-domain"] as const,
  queryFn: ({ signal }) => api.get("/server/panel-domain", { schema: panelDomainSettings, signal }),
});

export const serviceDomainQuery = queryOptions({
  queryKey: ["server", "service-domain"] as const,
  queryFn: ({ signal }) => api.get("/server/service-domain", { schema: serviceDomainSettings, signal }),
});

export const letsEncryptQuery = queryOptions({
  queryKey: ["server", "letsencrypt"] as const,
  queryFn: ({ signal }) => api.get("/server/letsencrypt-email", { schema: letsEncryptEmail, signal }),
});

export const trustedProxiesQuery = queryOptions({
  queryKey: ["server", "trusted"] as const,
  queryFn: ({ signal }) =>
    api.get("/server/proxy/trusted-proxies", { schema: trustedProxiesSettings, signal }),
});

export const customConfigQuery = queryOptions({
  queryKey: ["server", "custom-config"] as const,
  queryFn: ({ signal }) => api.get("/server/proxy/custom-config", { schema: proxyCustomConfig, signal }),
});

export const proxyEnvQuery = queryOptions({
  queryKey: ["server", "proxy-env"] as const,
  queryFn: ({ signal }) => api.get("/server/proxy/environment", { schema: proxyEnvironmentSummary, signal }),
});

export const dashboardQuery = queryOptions({
  queryKey: ["server", "dashboard"] as const,
  queryFn: ({ signal }) => api.get("/server/proxy/dashboard", { schema: proxyDashboardStatus, signal }),
});

export const dockerUpdateQuery = queryOptions({
  queryKey: ["server", "docker-update"] as const,
  queryFn: ({ signal }) => api.get("/server/docker/update", { schema: dockerUpdateCheck, signal }),
  retry: false,
  staleTime: 0,
});

export const cleanupPreviewQuery = (kind: DockerCleanupKind) =>
  queryOptions({
    queryKey: ["server", "cleanup", kind] as const,
    queryFn: ({ signal }) => api.get(`/server/docker/cleanup/${kind}`, { schema: cleanupPreview, signal }),
    retry: false,
    staleTime: 0,
  });

export const diskQuery = (path: string) =>
  queryOptions({
    queryKey: ["server", "disk", path] as const,
    queryFn: ({ signal }) => api.get("/server/disk", { schema: diskUsageListing, query: { path }, signal }),
    retry: false,
    staleTime: 10_000,
  });

export const serverApi = {
  setDailyCleanup: (enabled: boolean) => api.put("/server/daily-cleanup", { body: { enabled } }),
  setReleasesKept: (keep: number) => api.put("/server/releases-kept", { body: { keep } }),
  savePanelDomain: (body: SavePanelDomainRequest) =>
    api.put("/server/panel-domain", { body, schema: panelDomainSettings }),
  saveServiceDomain: (body: SaveServiceDomainRequest) =>
    api.put("/server/service-domain", { body, schema: serviceDomainSettings }),
  saveEmail: (email: string) => api.put("/server/letsencrypt-email", { body: { email } }),
  restartPanel: (confirm: string): Promise<ActionEntry> =>
    api.post("/server/panel/restart", { body: { confirm }, schema: actionEntry }),
  refreshIp: (): Promise<ActionEntry> => api.post("/server/panel/refresh-ip", { schema: actionEntry }),
  reboot: (confirm: string): Promise<ActionEntry> =>
    api.post("/server/reboot", { body: { confirm }, schema: actionEntry }),
  saveTrusted: (body: TrustedProxiesSettings): Promise<ActionEntry> =>
    api.put("/server/proxy/trusted-proxies", { body, schema: actionEntry }),
  saveCustomConfig: (yaml: string) => api.put("/server/proxy/custom-config", { body: { yaml } }),
  saveProxyEnv: (env: string) => api.put("/server/proxy/environment", { body: { env } }),
  revealProxyEnv: () => api.post("/server/proxy/environment/reveal", { schema: proxyEnvironment }),
  restartProxy: (confirm: string): Promise<ActionEntry> =>
    api.post("/server/proxy/restart", { body: { confirm }, schema: actionEntry }),
  openDashboard: () => api.post("/server/proxy/dashboard", { schema: proxyDashboard }),
  closeDashboard: () => api.delete("/server/proxy/dashboard"),
  runCleanup: (kind: DockerCleanupKind, confirm: string, items: string[]): Promise<ActionEntry> =>
    api.post(`/server/docker/cleanup/${kind}`, { body: { confirm, items }, schema: actionEntry }),
};

export const usersQuery = queryOptions({
  queryKey: ["users"] as const,
  queryFn: ({ signal }) => api.get("/users", { schema: userList, signal }),
});

/** Under "users", so refreshing the accounts also refreshes how many still lack two-factor sign-in. */
export const twoFactorPolicyQuery = queryOptions({
  queryKey: ["users", "two-factor-policy"] as const,
  queryFn: ({ signal }) => api.get("/settings/two-factor", { schema: twoFactorPolicyState, signal }),
});

export const myKeysQuery = queryOptions({
  queryKey: ["api-keys", "me"] as const,
  queryFn: ({ signal }) => api.get("/me/api-keys", { schema: apiKeyList, signal }),
});

export const userKeysQuery = (user: string) =>
  queryOptions({
    queryKey: ["api-keys", user] as const,
    queryFn: ({ signal }) => api.get(`/users/${user}/api-keys`, { schema: apiKeyList, signal }),
  });

export const accessApi = {
  createUser: (body: CreateUserRequest) => api.post("/users", { body, schema: panelUser }),
  updateUser: (id: string, body: UpdateUserRequest) => api.put(`/users/${id}`, { body, schema: panelUser }),
  deleteUser: (id: string, confirm: string) => api.delete(`/users/${id}`, { body: { confirm } }),
  setUserActive: (id: string, active: boolean) =>
    api.post(`/users/${id}/active`, { body: { active }, schema: panelUser }),
  createKey: (body: CreateApiKeyRequest) => api.post("/me/api-keys", { body, schema: createdApiKey }),
  revokeMyKey: (id: string) => api.delete(`/me/api-keys/${id}`),
  revokeUserKey: (user: string, id: string) => api.delete(`/users/${user}/api-keys/${id}`),
  saveTwoFactorPolicy: (body: TwoFactorPolicy) =>
    api.put("/settings/two-factor", { body, schema: twoFactorPolicyState }),
};

export const channelsQuery = queryOptions({
  queryKey: ["notifications", "channels"] as const,
  queryFn: ({ signal }) => api.get("/notifications/channels", { schema: notificationChannelList, signal }),
});

export const deliveriesQuery = queryOptions({
  queryKey: ["notifications", "deliveries"] as const,
  queryFn: ({ signal }) => api.get("/notifications/deliveries", { schema: notificationDeliveryList, signal }),
  refetchInterval: 15_000,
});

export const notificationsApi = {
  create: (body: SaveNotificationChannelRequest) =>
    api.post("/notifications/channels", { body, schema: notificationChannel }),
  update: (id: string, body: SaveNotificationChannelRequest) =>
    api.put(`/notifications/channels/${id}`, { body, schema: notificationChannel }),
  remove: (id: string) => api.delete(`/notifications/channels/${id}`),
  test: (body: TestNotificationRequest) =>
    api.post("/notifications/test", { body, schema: testNotificationResult }),
  setAllowPrivate: (allowPrivateDestinations: boolean) =>
    api.put("/notifications/settings", { body: { allowPrivateDestinations } }),
};

export const certificatesQuery = queryOptions({
  queryKey: ["certificates"] as const,
  queryFn: ({ signal }) => api.get("/certificates", { schema: certificateList, signal }),
});

export const certificatesApi = {
  remove: (id: string, confirm: string): Promise<ActionEntry> =>
    api.delete(`/certificates/${id}`, { body: { confirm }, schema: actionEntry }),
};

export const saveMonitoringSettings = (body: MonitoringSettings) =>
  api.put("/settings/monitoring", { body, schema: monitoringOverview });

export const serverBackupQuery = queryOptions({
  queryKey: [...serverKey, "backup"] as const,
  queryFn: () => api.get("/server/backup", { schema: serverBackupState }),
});

export const serverBackupApi = {
  save: (body: SaveServerBackupRequest) => api.put("/server/backup", { body, schema: serverBackupSaved }),
  run: () => api.post("/server/backup/run", { schema: actionEntry }),
  snapshots: () => api.get("/server/backup/snapshots", { schema: serverBackupSnapshots }),
  revealKey: (body: RevealServerBackupKeyRequest) =>
    api.post("/server/backup/key", { body, schema: serverBackupKey }),
};
