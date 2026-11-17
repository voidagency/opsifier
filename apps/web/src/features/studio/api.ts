import {
  type AddStudioGithubKeyRequest,
  type AddStudioProjectRequest,
  actionEntry,
  type CreateStudioGuestLinkRequest,
  createdStudioGuestLink,
  deletedStudioGithubKey,
  deletedStudioGuestLink,
  deletedStudioRemark,
  type LinkStudioAppRequest,
  type SetStudioMembersRequest,
  type StudioApp,
  type StudioMessageRequest,
  type StudioSettings,
  studioAppDetail,
  studioCheck,
  studioConversation,
  studioEventPage,
  studioGithubKey,
  studioGithubKeyCheck,
  studioGithubKeyList,
  studioGuestLinkList,
  studioIsolateAll,
  studioIsolated,
  studioMembers,
  studioModels,
  studioOverview,
  studioPreviewStart,
  studioRemark,
  studioRemarkList,
  studioSettings,
  type UpdateStudioRemarkRequest,
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

export const studioGithubKeysQuery = queryOptions({
  queryKey: [...studioKey, "github-keys"] as const,
  queryFn: ({ signal }) => api.get("/settings/studio/github-keys", { schema: studioGithubKeyList, signal }),
});

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

/** How often the remarks are read again, so that a client's new remark shows without a reload. */
const REMARKS_REFRESH_MS = 20_000;

export const studioRemarksQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...studioKey, "remarks", project, service] as const,
    queryFn: ({ signal }) =>
      api.get(`${appPath(project, service)}/remarks`, { schema: studioRemarkList, signal }),
    staleTime: 0,
    refetchInterval: REMARKS_REFRESH_MS,
  });

export const studioLinksQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...studioKey, "links", project, service] as const,
    queryFn: ({ signal }) =>
      api.get(`${appPath(project, service)}/links`, { schema: studioGuestLinkList, signal }),
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
  addGithubKey: (body: AddStudioGithubKeyRequest) =>
    api.post("/settings/studio/github-keys", { body, schema: studioGithubKey }),
  replaceGithubKey: (id: string, token: string) =>
    api.put(`/settings/studio/github-keys/${id}`, { body: { token }, schema: studioGithubKey }),
  removeGithubKey: (id: string) =>
    api.delete(`/settings/studio/github-keys/${id}`, { schema: deletedStudioGithubKey }),
  checkGithubKey: (id: string) =>
    api.post(`/settings/studio/github-keys/${id}/check`, { schema: studioGithubKeyCheck }),
  /** Takes the project out, with what the Studio made for it. Its folder stays. */
  remove: (project: string, service: string, confirm: string) =>
    api.post(`${appPath(project, service)}/remove`, { body: { confirm }, schema: actionEntry }),
  start: (project: string, service: string, body: StudioMessageRequest) =>
    api.post(`${appPath(project, service)}/conversations`, { body, schema: studioConversation }),
  send: (project: string, service: string, id: string, body: StudioMessageRequest) =>
    api.post(`${conversationPath(project, service, id)}/messages`, { body, schema: studioConversation }),
  stop: (project: string, service: string, id: string) =>
    api.post(`${conversationPath(project, service, id)}/stop`, { schema: studioConversation }),
  createLink: (project: string, service: string, body: CreateStudioGuestLinkRequest) =>
    api.post(`${appPath(project, service)}/links`, { body, schema: createdStudioGuestLink }),
  /** Takes a link back; with `withRemarks`, what was written through it goes too. */
  removeLink: (project: string, service: string, id: string, withRemarks = false) =>
    api.delete(`${appPath(project, service)}/links/${id}`, {
      query: withRemarks ? { remarks: "delete" } : {},
      schema: deletedStudioGuestLink,
    }),
  updateRemark: (project: string, service: string, id: string, body: UpdateStudioRemarkRequest) =>
    api.patch(`${appPath(project, service)}/remarks/${id}`, { body, schema: studioRemark }),
  deleteRemark: (project: string, service: string, id: string) =>
    api.delete(`${appPath(project, service)}/remarks/${id}`, { schema: deletedStudioRemark }),
  events: (project: string, service: string, id: string, after: string | null, signal?: AbortSignal) =>
    api.get(`${conversationPath(project, service, id)}/events`, {
      query: after === null ? {} : { after },
      schema: studioEventPage,
      signal,
    }),
};
