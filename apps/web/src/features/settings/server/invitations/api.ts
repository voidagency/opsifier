import {
  type CreateInvitationsRequest,
  createdInvitations,
  type InvitationLanguage,
  invitationList,
  type ResendInvitationRequest,
  resentInvitation,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../../../lib/api";

export const invitationsQuery = queryOptions({
  queryKey: ["invitations"] as const,
  queryFn: ({ signal }) => api.get("/users/invitations", { schema: invitationList, signal }),
  // While an e-mail is on its way, its row says when it has gone.
  refetchInterval: (query) =>
    query.state.data?.invitations.some((invitation) => invitation.delivery === "sending") ? 2000 : false,
});

export const invitationsApi = {
  invite: (body: CreateInvitationsRequest) =>
    api.post("/users/invitations", { body, schema: createdInvitations }),
  resend: (id: string, body: ResendInvitationRequest) =>
    api.post(`/users/invitations/${id}/resend`, { body, schema: resentInvitation }),
  revoke: (id: string) => api.delete(`/users/invitations/${id}`),
};

/** E-mails are written in the language the administrator is using. */
export const mailLanguage = (language: string): InvitationLanguage =>
  language.startsWith("fr") ? "fr" : "en";
