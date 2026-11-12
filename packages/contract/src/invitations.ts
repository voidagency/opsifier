import { z } from "zod";
import { accountEmail, accountPassword, projectGrant, projectGrants } from "./access";
import { actionEntry } from "./actions";
import { personName, userRole } from "./auth";

/** How long a link works. Sending an invitation again issues a new link, with a new term. */
export const INVITATION_DAYS = 7;
/** How many addresses one request may invite. */
export const MAX_INVITATIONS_PER_REQUEST = 100;
/** Where a link opens the panel. The token follows in the fragment, which never reaches a server log. */
export const INVITATION_PAGE_PATH = "/invitation";

/** The languages an invitation e-mail can be written in. */
export const invitationLanguage = z.enum(["en", "fr"]);
export type InvitationLanguage = z.infer<typeof invitationLanguage>;

/**
 * How the latest link reaches the person invited: `link` went to the administrator to pass on,
 * `sending` waits for its e-mail, `sent` was accepted by the mail server, and `failed` was not.
 */
export const invitationDelivery = z.enum(["link", "sending", "sent", "failed"]);
export type InvitationDelivery = z.infer<typeof invitationDelivery>;

/** An invitation nobody has accepted yet, as an administrator sees it. Its link is never part of it. */
export const invitation = z.object({
  id: z.string(),
  email: z.string(),
  role: userRole,
  projects: z.array(projectGrant),
  /** The administrator who sent it. It ends when they stop being one. */
  invitedBy: z.string(),
  createdAt: z.iso.datetime(),
  /** When the current link stops working. */
  expiresAt: z.iso.datetime(),
  expired: z.boolean(),
  delivery: invitationDelivery,
  /** The SMTP channel of the latest e-mail. Null when the link was handed over instead. */
  channelName: z.string().nullable(),
  /** When the mail server accepted the latest e-mail. */
  sentAt: z.iso.datetime().nullable(),
  /** Why the latest e-mail was not sent, with any secret removed. */
  error: z.string().nullable(),
});
export type Invitation = z.infer<typeof invitation>;

/** GET /api/v1/users/invitations */
export const invitationList = z.object({ invitations: z.array(invitation) });
export type InvitationList = z.infer<typeof invitationList>;

export const invitationPath = z.object({
  invitation: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id"),
});

/** The SMTP notification channel that e-mails the links. Null hands them to the caller instead. */
const deliveryChannel = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Choose an SMTP channel")
  .nullable()
  .default(null);

/** POST /api/v1/users/invitations */
export const createInvitationsRequest = z.strictObject({
  emails: z
    .array(accountEmail)
    .min(1, "Add at least one address")
    .max(MAX_INVITATIONS_PER_REQUEST, `At most ${MAX_INVITATIONS_PER_REQUEST} addresses at a time`),
  role: userRole.default("member"),
  projects: projectGrants.default([]),
  channel: deliveryChannel,
  /** The language of the e-mails. */
  language: invitationLanguage.default("en"),
});
export type CreateInvitationsRequest = z.input<typeof createInvitationsRequest>;

/**
 * What became of one address: `invited`, or left alone as a `duplicate` of one earlier in the list,
 * because it already has an account (`account_exists`), or because an invitation for it is still
 * waiting (`already_invited`). An expired invitation is replaced.
 */
export const invitationOutcome = z.enum(["invited", "duplicate", "account_exists", "already_invited"]);
export type InvitationOutcome = z.infer<typeof invitationOutcome>;

export const invitationResult = z.object({
  /** The address as it will sign in: trimmed and in lower case. */
  email: z.string(),
  outcome: invitationOutcome,
  /** The new invitation, for `invited`. */
  invitation: invitation.nullable(),
  /** The link to pass on, when no channel e-mails it. This answer is the only place it ever appears. */
  link: z.string().nullable(),
});
export type InvitationResult = z.infer<typeof invitationResult>;

/** The answer to inviting, one result per address in the order they were given. */
export const createdInvitations = z.object({
  results: z.array(invitationResult),
  /** The Action e-mailing the links, when a channel sends them and someone was invited. */
  action: actionEntry.nullable(),
});
export type CreatedInvitations = z.infer<typeof createdInvitations>;

/** POST /api/v1/users/invitations/{invitation}/resend */
export const resendInvitationRequest = z.strictObject({
  channel: deliveryChannel,
  language: invitationLanguage.default("en"),
});
export type ResendInvitationRequest = z.input<typeof resendInvitationRequest>;

/** The answer to sending an invitation again: its new link stops the old one from working. */
export const resentInvitation = z.object({
  invitation,
  link: z.string().nullable(),
  action: actionEntry.nullable(),
});
export type ResentInvitation = z.infer<typeof resentInvitation>;

const invitationToken = z.string().trim().min(1, "Required").max(128, "This link is not valid");

/** POST /api/v1/auth/invitation/check */
export const checkInvitationRequest = z.strictObject({ token: invitationToken });
export type CheckInvitationRequest = z.infer<typeof checkInvitationRequest>;

/** What a link offers, before anyone accepts it. */
export const invitationPreview = z.object({
  email: z.string(),
  role: userRole,
  /** Who sent it: their name when they gave one, otherwise their email. */
  invitedBy: z.string(),
  expiresAt: z.iso.datetime(),
});
export type InvitationPreview = z.infer<typeof invitationPreview>;

/** POST /api/v1/auth/invitation/accept: creates the account and signs it in. */
export const acceptInvitationRequest = z.strictObject({
  token: invitationToken,
  name: personName,
  password: accountPassword,
});
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequest>;
