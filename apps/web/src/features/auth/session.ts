import {
  type AcceptInvitationRequest,
  type ChangeCredentialsRequest,
  type CheckInvitationRequest,
  invitationPreview,
  type LoginRequest,
  type SessionState,
  type SessionUser,
  type SetupRequest,
  sessionState,
  type TwoFactorBegin,
  type TwoFactorConfirm,
  type TwoFactorDisable,
  twoFactorEnabled,
  twoFactorSetup,
} from "@opsifier/contract";
import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";

/** Long enough to survive a slow link, short enough that a dead server shows an error instead of a blank page. */
const sessionTimeoutMs = 10_000;

/** The session decides every redirect, so it is only refetched when something can have changed it. */
export const sessionQuery = queryOptions({
  queryKey: ["auth", "session"] as const,
  queryFn: ({ signal }) =>
    api.get<SessionState>("/auth/session", {
      schema: sessionState,
      signal: AbortSignal.any([signal, AbortSignal.timeout(sessionTimeoutMs)]),
    }),
  staleTime: Number.POSITIVE_INFINITY,
  retry: false,
});

/** Every auth endpoint answers with the resulting session, which replaces the cached one. */
export function applySession(queryClient: QueryClient, session: SessionState): void {
  queryClient.setQueryData(sessionQuery.queryKey, session);
}

/** The signed-in user. Null only in the moment between a session ending and the redirect. */
export function useCurrentUser(): SessionUser | null {
  const { data } = useQuery(sessionQuery);
  return data?.status === "signed-in" ? data.user : null;
}

export const authApi = {
  setup: (body: SetupRequest) => api.post("/auth/setup", { body, schema: sessionState }),
  login: (body: LoginRequest) => api.post("/auth/login", { body, schema: sessionState }),
  logout: () => api.post("/auth/logout", { schema: sessionState }),
  changeCredentials: (body: ChangeCredentialsRequest) =>
    api.post("/auth/credentials", { body, schema: sessionState }),
  beginTwoFactor: (body: TwoFactorBegin) =>
    api.post("/auth/two-factor/begin", { body, schema: twoFactorSetup }),
  enableTwoFactor: (body: TwoFactorConfirm) =>
    api.post("/auth/two-factor/enable", { body, schema: twoFactorEnabled }),
  disableTwoFactor: (body: TwoFactorDisable) =>
    api.post("/auth/two-factor/disable", { body, schema: sessionState }),
  checkInvitation: (body: CheckInvitationRequest) =>
    api.post("/auth/invitation/check", { body, schema: invitationPreview }),
  acceptInvitation: (body: AcceptInvitationRequest) =>
    api.post("/auth/invitation/accept", { body, schema: sessionState }),
};
