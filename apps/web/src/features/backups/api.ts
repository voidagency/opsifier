import {
  actionEntry,
  backupConfigEntry,
  backupsDocument,
  databaseNameList,
  type ResolveRestoreRequest,
  type RestoreBackupRequest,
  type RestoreFromPathRequest,
  type RunBackupRequest,
  restoreEntry,
  type SaveBackupConfigRequest,
  storageProviderOptions,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { serviceKey } from "../services/api";

const base = (project: string, service: string) => `/projects/${project}/services/${service}/backups`;

export const backupsKey = (project: string, service: string) =>
  [...serviceKey(project, service), "backups"] as const;

export const backupsQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: backupsKey(project, service),
    queryFn: ({ signal }) => api.get(base(project, service), { schema: backupsDocument, signal }),
    staleTime: 0,
  });

export const destinationsQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...backupsKey(project, service), "destinations"] as const,
    queryFn: ({ signal }) =>
      api.get(`${base(project, service)}/destinations`, { schema: storageProviderOptions, signal }),
    staleTime: 0,
  });

export const databasesQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...backupsKey(project, service), "databases"] as const,
    queryFn: ({ signal }) =>
      api.get(`${base(project, service)}/databases`, { schema: databaseNameList, signal }),
    staleTime: 0,
    retry: false,
  });

/** Where a browser fetches one stored file from. It is a plain link, so the session cookie goes with it. */
export const backupDownloadUrl = (project: string, service: string, id: string): string =>
  `/api/v1${base(project, service)}/${id}/download`;

export const backupsApi = {
  createConfig: (project: string, service: string, body: SaveBackupConfigRequest) =>
    api.post(`${base(project, service)}/configs`, { body, schema: backupConfigEntry }),
  updateConfig: (project: string, service: string, id: string, body: SaveBackupConfigRequest) =>
    api.put(`${base(project, service)}/configs/${id}`, { body, schema: backupConfigEntry }),
  deleteConfig: (project: string, service: string, id: string) =>
    api.delete(`${base(project, service)}/configs/${id}`),
  run: (project: string, service: string, id: string, body: RunBackupRequest) =>
    api.post(`${base(project, service)}/configs/${id}/run`, { body, schema: actionEntry }),
  restore: (project: string, service: string, id: string, body: RestoreBackupRequest) =>
    api.post(`${base(project, service)}/${id}/restore`, { body, schema: actionEntry }),
  restoreFromPath: (project: string, service: string, body: RestoreFromPathRequest) =>
    api.post(`${base(project, service)}/restore`, { body, schema: actionEntry }),
  removeBackup: (project: string, service: string, id: string) =>
    api.delete(`${base(project, service)}/${id}`, { schema: actionEntry }),
  resolveRestore: (project: string, service: string, id: string, body: ResolveRestoreRequest) =>
    api.post(`${base(project, service)}/restores/${id}/resolve`, { body, schema: restoreEntry }),
  discardEarlierCopy: (project: string, service: string, id: string, body: ResolveRestoreRequest) =>
    api.post(`${base(project, service)}/restores/${id}/discard-earlier-copy`, { body, schema: restoreEntry }),
};
