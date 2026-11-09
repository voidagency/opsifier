import {
  type ScriptSpec,
  scriptList,
  scriptRun,
  scriptRunDetail,
  scriptRunPage,
  startedScriptRun,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../../../lib/api";
import { serviceKey } from "../../api";

const path = (project: string, service: string) => `/projects/${project}/services/${service}/scripts`;
const runsPath = (project: string, service: string) => `/projects/${project}/services/${service}/script-runs`;

const runsKey = (project: string, service: string) =>
  [...serviceKey(project, service), "script-runs"] as const;

const ACTIVE_REFRESH_MS = 2000;
/** A skipped due time starts no Action, so nothing else would announce it. */
const IDLE_REFRESH_MS = 30_000;

export const scriptsQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "scripts"] as const,
    queryFn: ({ signal }) => api.get(path(project, service), { schema: scriptList, signal }),
    staleTime: 0,
  });

export const scriptRunsQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: runsKey(project, service),
    queryFn: ({ signal }) =>
      api.get(`${runsPath(project, service)}?limit=25`, { schema: scriptRunPage, signal }),
    staleTime: 0,
    refetchInterval: ({ state }) =>
      state.data?.items.some((run) => run.status === "queued" || run.status === "running")
        ? ACTIVE_REFRESH_MS
        : IDLE_REFRESH_MS,
  });

export const scriptRunQuery = (project: string, service: string, id: string) =>
  queryOptions({
    queryKey: [...runsKey(project, service), id] as const,
    queryFn: ({ signal }) =>
      api.get(`${runsPath(project, service)}/${id}`, { schema: scriptRunDetail, signal }),
    staleTime: 0,
    refetchInterval: ({ state }) =>
      state.data === undefined || state.data.status === "queued" || state.data.status === "running"
        ? ACTIVE_REFRESH_MS
        : false,
  });

export const scriptsApi = {
  add: (project: string, service: string, body: ScriptSpec) =>
    api.post(path(project, service), { body, schema: scriptList }),
  update: (project: string, service: string, index: number, body: ScriptSpec) =>
    api.put(`${path(project, service)}/${index}`, { body, schema: scriptList }),
  remove: (project: string, service: string, index: number) =>
    api.delete(`${path(project, service)}/${index}`, { schema: scriptList }),
  run: (project: string, service: string, name: string) =>
    api.post(runsPath(project, service), { body: { script: name }, schema: startedScriptRun }),
  cancel: (project: string, service: string, id: string) =>
    api.post(`${runsPath(project, service)}/${id}/cancel`, { schema: scriptRun }),
};
