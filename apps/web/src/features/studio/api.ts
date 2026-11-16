import {
  type AddStudioProjectRequest,
  actionEntry,
  type LinkStudioAppRequest,
  type SetStudioMembersRequest,
  type StudioApp,
  type StudioMessageRequest,
  type StudioSettings,
  studioAppDetail,
  studioCheck,
  studioConversation,
  studioEventPage,
  studioIsolateAll,
  studioIsolated,
  studioMembers,
  studioModels,
  studioOverview,
  studioPreviewStart,
  studioSettings,
  unlinkedStudioApp,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../lib/api";

export const studioKey = ["studio"] as const;

/** A Studio project's name: its folder's, the same wherever its preview lives. */
export const studioAppName = (app: Pick<StudioApp, "workspaceDir" | "service">): string =>
  app.workspaceDir.split("/").filter(Boolean).at(-1) ?? app.service;

const appPath = (project: string, service: string) => `/projects/${project}/services/${service}/studio`;
const conversationPath = (project: string, service: string, id: string) =>
  `${appPath(project, service)}/conversations/${id}`;

export const studioOverviewQuery = queryOptions({
  queryKey: [...studioKey, "overview"] as const,
  queryFn: ({ signal }) => api.get("/studio", { schema: studioOverview, signal }),
  staleTime: 0,
});

export const studioAppQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...studioKey, "apps", project, service] as const,
    queryFn: ({ signal }) => api.get(appPath(project, service), { schema: studioAppDetail, signal }),
    staleTime: 0,
  });

export const studioModelsQuery = queryOptions({
  queryKey: [...studioKey, "models"] as const,
  queryFn: ({ signal }) => api.get("/studio/models", { schema: studioModels, signal }),
  staleTime: 60_000,
});

export const studioMembersQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...studioKey, "members", project, service] as const,
    queryFn: ({ signal }) =>
      api.get(`${appPath(project, service)}/members`, { schema: studioMembers, signal }),
    staleTime: 0,
  });

export const studioSettingsQuery = queryOptions({
  queryKey: [...studioKey, "settings"] as const,
  queryFn: ({ signal }) => api.get("/settings/studio", { schema: studioSettings, signal }),
  staleTime: 0,
});

export const studioApi = {
  saveSettings: (body: StudioSettings) => api.put("/settings/studio", { body, schema: studioSettings }),
  check: () => api.post("/settings/studio/check", { schema: studioCheck }),
  addProject: (body: AddStudioProjectRequest) =>
    api.post("/studio/projects", { body, schema: studioAppDetail }),
  setMembers: (project: string, service: string, body: SetStudioMembersRequest) =>
    api.put(`${appPath(project, service)}/members`, { body, schema: studioMembers }),
  isolate: (project: string, service: string) =>
    api.post(`${appPath(project, service)}/isolate`, { schema: studioIsolated }),
  isolateAll: () => api.post("/studio/isolate", { schema: studioIsolateAll }),
  startPreview: (project: string, service: string) =>
    api.post(`${appPath(project, service)}/preview/start`, { schema: studioPreviewStart }),
  link: (project: string, service: string, body: LinkStudioAppRequest) =>
    api.put(appPath(project, service), { body, schema: studioAppDetail }),
  unlink: (project: string, service: string) =>
    api.delete(appPath(project, service), { schema: unlinkedStudioApp }),
  /** Takes the project out, with what the Studio made for it. Its folder stays. */
  remove: (project: string, service: string, confirm: string) =>
    api.post(`${appPath(project, service)}/remove`, { body: { confirm }, schema: actionEntry }),
  start: (project: string, service: string, body: StudioMessageRequest) =>
    api.post(`${appPath(project, service)}/conversations`, { body, schema: studioConversation }),
  send: (project: string, service: string, id: string, body: StudioMessageRequest) =>
    api.post(`${conversationPath(project, service, id)}/messages`, { body, schema: studioConversation }),
  stop: (project: string, service: string, id: string) =>
    api.post(`${conversationPath(project, service, id)}/stop`, { schema: studioConversation }),
  events: (project: string, service: string, id: string, after: string | null, signal?: AbortSignal) =>
    api.get(`${conversationPath(project, service, id)}/events`, {
      query: after === null ? {} : { after },
      schema: studioEventPage,
      signal,
    }),
};
