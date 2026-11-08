import {
  type AutoDeployRequest,
  type BuildConfig,
  type EnvFileSettings,
  envFileSettings,
  githubBranchList,
  githubRepositoryList,
  githubStatus,
  type ServiceSource,
  saveBuildResponse,
  serviceSource,
  sourceSettings,
  sshKeyResponse,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { ApiError, api, clientErrorCode } from "../../../../lib/api";
import { serviceKey } from "../../api";

const base = (project: string, service: string) => `/projects/${project}/services/${service}/source`;

export const sourceSettingsKey = (project: string, service: string) =>
  [...serviceKey(project, service), "source"] as const;

export const sourceSettingsQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: sourceSettingsKey(project, service),
    queryFn: ({ signal }) => api.get(base(project, service), { schema: sourceSettings, signal }),
    staleTime: 0,
  });

export const envFileQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...sourceSettingsKey(project, service), "env-file"] as const,
    queryFn: ({ signal }) =>
      api.get(`${base(project, service)}/env-file`, { schema: envFileSettings, signal }),
    staleTime: 0,
  });

export const githubRepositoriesQuery = (search: string) =>
  queryOptions({
    queryKey: ["github", "repositories", search] as const,
    queryFn: ({ signal }) =>
      api.get("/github/repositories", { query: { q: search }, schema: githubRepositoryList, signal }),
    staleTime: 30_000,
  });

export const githubBranchesQuery = (repository: string) =>
  queryOptions({
    queryKey: ["github", "branches", repository] as const,
    queryFn: ({ signal }) =>
      api.get(`/github/repositories/${repository}/branches`, { schema: githubBranchList, signal }),
    staleTime: 30_000,
  });

export const githubStatusQuery = queryOptions({
  queryKey: ["github", "status"] as const,
  queryFn: ({ signal }) => api.get("/settings/github", { schema: githubStatus, signal }),
  staleTime: 0,
});

/** XHR, not fetch: only XHR reports how far an upload has got. */
function sendArchive(
  url: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<ServiceSource> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.setRequestHeader("Accept", "application/json");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(event.loaded / event.total);
      }
    };
    request.onerror = () =>
      reject(new ApiError(0, clientErrorCode.network, "The server could not be reached"));
    request.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(request.responseText);
      } catch {
        reject(
          new ApiError(request.status, clientErrorCode.badResponse, "The server sent an unreadable response"),
        );
        return;
      }
      if (request.status >= 200 && request.status < 300) {
        resolve(serviceSource.parse(body));
        return;
      }
      const error = (body as { error?: { code?: string; message?: string; fields?: Record<string, string> } })
        .error;
      reject(
        new ApiError(
          request.status,
          error?.code ?? clientErrorCode.badResponse,
          error?.message ?? request.statusText,
          error?.fields,
        ),
      );
    };
    request.send(file);
  });
}

export const sourceApi = {
  saveBuild: (project: string, service: string, build: BuildConfig | null) =>
    api.put(`${base(project, service)}/build`, {
      body: { build },
      schema: saveBuildResponse,
    }),
  generateSshKey: (project: string, service: string) =>
    api.post(`${base(project, service)}/ssh-key`, { schema: sshKeyResponse }),
  setAutoDeploy: (project: string, service: string, body: AutoDeployRequest) =>
    api.put(`${base(project, service)}/auto-deploy`, { body, schema: serviceSource }),
  saveEnvFile: (project: string, service: string, body: EnvFileSettings) =>
    api.put(`${base(project, service)}/env-file`, { body, schema: envFileSettings }),
  upload: (
    project: string,
    service: string,
    file: File,
    path: string,
    onProgress: (fraction: number) => void,
  ): Promise<ServiceSource> =>
    sendArchive(
      `/api/v1${base(project, service)}/upload?fileName=${encodeURIComponent(file.name)}&path=${encodeURIComponent(path)}`,
      file,
      onProgress,
    ),
};
