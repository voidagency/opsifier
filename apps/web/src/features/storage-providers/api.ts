import {
  type CreateStorageProviderRequest,
  checkStorageProviderResponse,
  oauthStartResponse,
  storageProviderEntry,
  storageProviderList,
  type UpdateStorageProviderRequest,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../lib/api";

const BASE = "/storage-providers";

export const storageProvidersKey = ["storage-providers"] as const;

export const storageProvidersQuery = queryOptions({
  queryKey: storageProvidersKey,
  queryFn: ({ signal }) => api.get(BASE, { schema: storageProviderList, signal }),
  staleTime: 0,
});

export const storageProvidersApi = {
  create: (body: CreateStorageProviderRequest) => api.post(BASE, { body, schema: storageProviderEntry }),
  update: (id: string, body: UpdateStorageProviderRequest) =>
    api.put(`${BASE}/${id}`, { body, schema: storageProviderEntry }),
  remove: (id: string) => api.delete(`${BASE}/${id}`),
  check: (id: string) => api.post(`${BASE}/${id}/check`, { schema: checkStorageProviderResponse }),
  connect: (id: string) => api.post(`${BASE}/${id}/connect`, { schema: oauthStartResponse }),
  disconnect: (id: string) => api.post(`${BASE}/${id}/disconnect`, { schema: storageProviderEntry }),
};
