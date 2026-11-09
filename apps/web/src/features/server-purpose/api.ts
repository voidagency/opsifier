import {
  type AllowlistEntry,
  allowlistEntry,
  allowlistState,
  type CreateAllowlistEntryRequest,
  type CreateProtectionUserRequest,
  deletedProtectionItem,
  type ProtectionUserResult,
  protectionUserList,
  protectionUserResult,
  type ServerPurpose,
  type SetServerPurposeResult,
  serverPurposeState,
  setServerPurposeResult,
  type UpdateProtectionUserRequest,
} from "@opsifier/contract";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { api } from "../../lib/api";

export const purposeKey = ["server-purpose"] as const;

const REFRESH_MS = 15_000;

/** The purpose and the protection: the top bar reads this on every page. */
export const purposeQuery = queryOptions({
  queryKey: purposeKey,
  queryFn: ({ signal }) => api.get("/server-purpose", { schema: serverPurposeState, signal }),
  refetchInterval: REFRESH_MS,
  retry: false,
});

export const protectionUsersQuery = queryOptions({
  queryKey: [...purposeKey, "users"] as const,
  queryFn: ({ signal }) => api.get("/server-purpose/users", { schema: protectionUserList, signal }),
  staleTime: 0,
});

export const allowlistQuery = queryOptions({
  queryKey: [...purposeKey, "allowlist"] as const,
  queryFn: ({ signal }) => api.get("/server-purpose/allowlist", { schema: allowlistState, signal }),
  staleTime: 0,
});

export const refreshPurpose = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: purposeKey });

export const purposeApi = {
  set: (purpose: ServerPurpose, confirm?: string): Promise<SetServerPurposeResult> =>
    api.put("/server-purpose", { body: { purpose, confirm }, schema: setServerPurposeResult }),
  addUser: (body: CreateProtectionUserRequest): Promise<ProtectionUserResult> =>
    api.post("/server-purpose/users", { body, schema: protectionUserResult }),
  updateUser: (id: string, body: UpdateProtectionUserRequest): Promise<ProtectionUserResult> =>
    api.put(`/server-purpose/users/${id}`, { body, schema: protectionUserResult }),
  removeUser: (id: string) => api.delete(`/server-purpose/users/${id}`, { schema: deletedProtectionItem }),
  addAllowlistEntry: (body: CreateAllowlistEntryRequest): Promise<AllowlistEntry> =>
    api.post("/server-purpose/allowlist", { body, schema: allowlistEntry }),
  removeAllowlistEntry: (id: string) =>
    api.delete(`/server-purpose/allowlist/${id}`, { schema: deletedProtectionItem }),
};
