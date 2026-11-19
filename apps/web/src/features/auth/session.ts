import {
  type AcceptInvitationRequest,
  type ChangeCredentialsRequest,
  type CheckInvitationRequest,
  type CliLoginApprove,
  cliLoginAnswered,
  cliLoginRequest,
  invitationPreview,
  type LoginRequest,
  type OpenedSession,
  openedSession,
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
import { keepSessionBinding } from "../../lib/session-binding";

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

/**
 * A sign-in over plain HTTP answers with the session's second secret, kept for this address only and
 * not in the cached session; any other sign-in forgets the previous one.
 */
function keepBinding(opened: OpenedSession): SessionState {
  const { binding, ...state } = opened;
  keepSessionBinding(binding);
  return state;
}

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
  setup: (body: SetupRequest) => api.post("/auth/setup", { body, schema: openedSession }).then(keepBinding),
  login: (body: LoginRequest) => api.post("/auth/login", { body, schema: openedSession }).then(keepBinding),
  logout: () =>
    api.post("/auth/logout", { schema: sessionState }).finally(() => keepSessionBinding(undefined)),
  changeCredentials: (body: ChangeCredentialsRequest) =>
    api.post("/auth/credentials", { body, schema: sessionState }),
  beginTwoFactor: (body: TwoFactorBegin) =>
    api.post("/auth/two-factor/begin", { body, schema: twoFactorSetup }),
  enableTwoFactor: (body: TwoFactorConfirm) =>
    api.post("/auth/two-factor/enable", { body, schema: twoFactorEnabled }),
  disableTwoFactor: (body: TwoFactorDisable) =>
    api.post("/auth/two-factor/disable", { body, schema: sessionState }),
  cliLoginRequest: (code: string) =>
    api.get(`/auth/cli/requests/${encodeURIComponent(code)}`, { schema: cliLoginRequest }),
  approveCliLogin: (code: string, body: CliLoginApprove) =>
    api.post(`/auth/cli/requests/${encodeURIComponent(code)}/approve`, { body, schema: cliLoginAnswered }),
  denyCliLogin: (code: string) =>
    api.post(`/auth/cli/requests/${encodeURIComponent(code)}/deny`, { schema: cliLoginAnswered }),
  checkInvitation: (body: CheckInvitationRequest) =>
    api.post("/auth/invitation/check", { body, schema: invitationPreview }),
  acceptInvitation: (body: AcceptInvitationRequest) =>
    api.post("/auth/invitation/accept", { body, schema: openedSession }).then(keepBinding),
};
