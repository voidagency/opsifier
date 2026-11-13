import { randomBytes } from "node:crypto";
import type {
  AcceptInvitationRequest,
  CreatedInvitations,
  Invitation,
  InvitationLanguage,
  InvitationOutcome,
  InvitationPreview,
  ProjectGrant,
  ResentInvitation,
  UserRole,
} from "@opsifier/contract";
import {
  type createInvitationsRequest,
  INVITATION_DAYS,
  INVITATION_PAGE_PATH,
  type resendInvitationRequest,
  userRole,
} from "@opsifier/contract";
import { nanoid } from "nanoid";
import type { z } from "zod";
import { type ActionContext, type ActionRow, toActionEntry } from "../../core/actions";
import {
  hashPassword,
  hashToken,
  insertSession,
  type Principal,
  type RequestMeta,
  toSessionUser,
  UNKNOWN_IP,
} from "../../core/auth";
import type { AppDeps } from "../../core/context";
import { AppError, badRequest, conflict, notFound } from "../../core/errors";
import * as accessRepo from "../access/repo";
import type { SignedIn } from "../auth/service";
import { findSmtpChannel, sendMailThrough } from "../notifications/service";
import { getPanelDomainSettings } from "../server/settings";
import { getSystemInfo } from "../system/service";
import { needsTwoFactorSetup } from "../two-factor-policy/service";
import { invitationMail } from "./mail";
import * as repo from "./repo";

type SessionPrincipal = Extract<Principal, { kind: "session" }>;
type CreateRequest = z.output<typeof createInvitationsRequest>;
type ResendRequest = z.output<typeof resendInvitationRequest>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Every token is 32 random bytes in base64url: anything else was never issued. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Plenty for any team, and a bound on what one panel keeps. */
export const MAX_STORED_INVITATIONS = 500;

const INTERRUPTED = "The panel restarted before this e-mail went out. Send the invitation again.";
const CANCELLED = "The sending was cancelled before this e-mail went out. Send the invitation again.";
const INVALID_LINK =
  "This invitation link no longer works: it was used, replaced or taken back, or it expired. Ask an administrator for a new one.";

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const invitationInvalid = () => new AppError(404, "invitation_invalid", INVALID_LINK);

function newToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

/** An invitation speaks for whoever sent it, so it only works while they are an administrator in use. */
const canStillInvite = (inviter: Pick<repo.InviterRow, "role" | "deactivatedAt">) =>
  inviter.role === "admin" && inviter.deactivatedAt === null;

function toInvitation(row: repo.InvitationRow, inviterEmail: string, now: number): Invitation {
  return {
    id: row.id,
    email: row.email,
    role: userRole.parse(row.role),
    projects: row.projects,
    invitedBy: inviterEmail,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    expired: row.expiresAt.getTime() <= now,
    delivery: row.delivery,
    channelName: row.channelName,
    sentAt: row.sentAt?.toISOString() ?? null,
    error: row.deliveryError,
  };
}

export function listInvitations(deps: AppDeps): Invitation[] {
  const now = deps.now();
  return repo
    .listInvitations(deps.db)
    .map(({ invitation, inviter }) => toInvitation(invitation, inviter.email, now));
}

/**
 * Where the people invited open the panel: its own domain when it has one, otherwise the address the
 * administrator is using right now.
 */
function panelBase(deps: AppDeps, requestOrigin: string): string {
  return getPanelDomainSettings(deps).url ?? requestOrigin;
}

/** Names the panel answers on when it has no domain: its server's address, and this machine. */
function isOwnAddress(deps: AppDeps, hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  return ["localhost", "127.0.0.1", "::1", getSystemInfo(deps).serverIp].includes(bare);
}

/**
 * The address an e-mailed link opens. A link handed to an administrator only goes where they pass it,
 * but an e-mail goes out under the panel's name, so its link may only ever point at the panel itself,
 * never at a host a request claims.
 */
function mailBase(deps: AppDeps, requestOrigin: string): string {
  const own = getPanelDomainSettings(deps).url;
  if (own !== null) {
    return own;
  }
  if (!isOwnAddress(deps, new URL(requestOrigin).hostname)) {
    throw conflict(
      "panel_address_unknown",
      "This panel has no domain of its own to put in an e-mail. Set one in Settings → General, or hand the links over instead.",
    );
  }
  return requestOrigin;
}

const linkFor = (base: string, token: string) => `${base}${INVITATION_PAGE_PATH}#${token}`;

function assertProjectsExist(deps: AppDeps, grants: readonly ProjectGrant[]): void {
  const found = accessRepo.existingProjects(
    deps.db,
    grants.map((grant) => grant.project),
  );
  const missing = grants.find((grant) => !found.has(grant.project));
  if (missing !== undefined) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      projects: `Project ${missing.project} does not exist`,
    });
  }
}

function resolveChannel(deps: AppDeps, id: string | null): { id: string; name: string } | null {
  if (id === null) {
    return null;
  }
  const channel = findSmtpChannel(deps, id);
  if (channel === null) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      channel: "No SMTP channel has this id",
    });
  }
  return channel;
}

interface Outgoing {
  id: string;
  email: string;
  role: UserRole;
  tokenHash: string;
  link: string;
  expiresAt: Date;
}

interface Sending {
  channel: { id: string; name: string };
  language: InvitationLanguage;
  inviter: string;
  panel: string;
}

async function sendAll(
  deps: AppDeps,
  ctx: ActionContext,
  sending: Sending,
  outgoing: readonly Outgoing[],
): Promise<void> {
  let failed = 0;
  for (const [index, item] of outgoing.entries()) {
    if (ctx.signal.aborted) {
      for (const rest of outgoing.slice(index)) {
        repo.recordDelivery(deps.db, rest.id, rest.tokenHash, {
          delivery: "failed",
          deliveryError: CANCELLED,
        });
      }
      ctx.log(`Cancelled with ${outgoing.length - index} e-mail(s) not sent.`);
      return;
    }
    // Taken back or sent again since: this link no longer works, so it must not go out.
    if (repo.findInvitation(deps.db, item.id)?.tokenHash !== item.tokenHash) {
      ctx.log(`Skipped ${item.email}: the invitation was taken back or sent again since.`);
      continue;
    }
    const mail = invitationMail({
      language: sending.language,
      inviter: sending.inviter,
      panel: sending.panel,
      role: item.role,
      link: item.link,
      expiresAt: item.expiresAt,
    });
    try {
      const reply = await sendMailThrough(deps, sending.channel.id, item.email, {
        id: `invitation-${item.id}`,
        ...mail,
      });
      repo.recordDelivery(deps.db, item.id, item.tokenHash, {
        delivery: "sent",
        sentAt: new Date(deps.now()),
        deliveryError: null,
      });
      ctx.log(`Sent to ${item.email}. The mail server answered: ${reply}`);
    } catch (error) {
      failed += 1;
      const reason = (error instanceof Error ? error.message : "The e-mail could not be sent.").slice(0, 500);
      repo.recordDelivery(deps.db, item.id, item.tokenHash, { delivery: "failed", deliveryError: reason });
      ctx.log(`Could not send to ${item.email}: ${reason}`);
    }
  }
  if (failed > 0) {
    throw new Error(`${failed} of ${outgoing.length} invitation e-mail(s) could not be sent.`);
  }
}

/**
 * E-mails the links as an Action, so a slow mail server holds up nobody and every send is in the log.
 * The links live only in this closure: a restart loses them, and the boot marks those invitations failed.
 */
function startSending(
  deps: AppDeps,
  actor: SessionPrincipal,
  sending: Sending,
  outgoing: readonly Outgoing[],
): ActionRow | null {
  const [first] = outgoing;
  if (first === undefined) {
    return null;
  }
  try {
    return deps.actions.enqueue({
      type: "auth.invitation-send",
      title:
        outgoing.length === 1
          ? `E-mail the invitation to ${first.email}`
          : `E-mail ${outgoing.length} invitations`,
      actorEmail: actor.user.email,
      run: (ctx) => sendAll(deps, ctx, sending, outgoing),
    });
  } catch (error) {
    // The invitations exist already: say why their e-mails never left rather than leave them waiting.
    const reason = error instanceof Error ? error.message : "The e-mails could not be queued.";
    for (const item of outgoing) {
      repo.recordDelivery(deps.db, item.id, item.tokenHash, { delivery: "failed", deliveryError: reason });
    }
    return null;
  }
}

function describeBatch(emails: readonly string[]): string {
  const [first] = emails;
  if (emails.length === 1) {
    return `Invite ${first}`;
  }
  return `Invite ${first} and ${emails.length - 1} more`;
}

interface Planned {
  email: string;
  outcome: InvitationOutcome;
  row?: repo.InvitationRow;
  token?: string;
}

/**
 * Invites every address it can. A duplicate, an address with an account and one with an invitation
 * still waiting are reported and left alone, without stopping the others.
 */
export function createInvitations(
  deps: AppDeps,
  actor: SessionPrincipal,
  request: CreateRequest,
  requestOrigin: string,
): CreatedInvitations {
  const grants = request.role === "admin" ? [] : [...request.projects];
  assertProjectsExist(deps, grants);
  const channel = resolveChannel(deps, request.channel);
  const base = channel === null ? panelBase(deps, requestOrigin) : mailBase(deps, requestOrigin);
  const now = deps.now();
  const expiresAt = new Date(now + INVITATION_DAYS * MS_PER_DAY);

  const planned = deps.db.transaction(
    (tx) => {
      const seen = new Set<string>();
      const results: Planned[] = [];
      for (const given of request.emails) {
        const email = normalizeEmail(given);
        if (seen.has(email)) {
          results.push({ email, outcome: "duplicate" });
          continue;
        }
        seen.add(email);
        if (accessRepo.findUserByEmail(tx, email) !== undefined) {
          results.push({ email, outcome: "account_exists" });
          continue;
        }
        const waiting = repo.findByEmail(tx, email);
        if (waiting !== undefined) {
          if (waiting.expiresAt.getTime() > now) {
            results.push({ email, outcome: "already_invited" });
            continue;
          }
          repo.deleteInvitation(tx, waiting.id);
        }
        const { token, tokenHash } = newToken();
        const row = repo.insertInvitation(tx, {
          id: nanoid(),
          email,
          role: request.role,
          projects: grants,
          tokenHash,
          invitedBy: actor.user.id,
          delivery: channel === null ? "link" : "sending",
          channelName: channel?.name ?? null,
          sentAt: null,
          deliveryError: null,
          createdAt: new Date(now),
          expiresAt,
        });
        results.push({ email, outcome: "invited", row, token });
      }
      if (repo.countInvitations(tx) > MAX_STORED_INVITATIONS) {
        throw conflict(
          "too_many_invitations",
          `A panel keeps at most ${MAX_STORED_INVITATIONS} invitations. Revoke some first.`,
        );
      }
      return results;
    },
    { behavior: "immediate" },
  );

  const invited = planned.filter((entry) => entry.row !== undefined && entry.token !== undefined);
  if (invited.length > 0) {
    deps.actions.record({
      type: "auth.invitation-create",
      title: describeBatch(invited.map((entry) => entry.email)),
      actorEmail: actor.user.email,
    });
  }

  const action =
    channel === null
      ? null
      : startSending(
          deps,
          actor,
          { channel, language: request.language, inviter: actor.user.email, panel: new URL(base).host },
          invited.map((entry) => ({
            id: entry.row?.id ?? "",
            email: entry.email,
            role: request.role,
            tokenHash: entry.row?.tokenHash ?? "",
            link: linkFor(base, entry.token ?? ""),
            expiresAt,
          })),
        );

  return {
    results: planned.map((entry) => ({
      email: entry.email,
      outcome: entry.outcome,
      // Read back: e-mails that could not even be queued are already marked failed.
      invitation:
        entry.row === undefined
          ? null
          : toInvitation(repo.findInvitation(deps.db, entry.row.id) ?? entry.row, actor.user.email, now),
      link: channel === null && entry.token !== undefined ? linkFor(base, entry.token) : null,
    })),
    action: action === null ? null : toActionEntry(action),
  };
}

/** A new link, with a new term. The old one stops working at once, wherever it was sent. */
export function resendInvitation(
  deps: AppDeps,
  actor: SessionPrincipal,
  id: string,
  request: ResendRequest,
  requestOrigin: string,
): ResentInvitation {
  const current = repo.findInvitation(deps.db, id);
  if (current === undefined) {
    throw notFound("This invitation does not exist.");
  }
  if (accessRepo.findUserByEmail(deps.db, current.email) !== undefined) {
    throw conflict("email_taken", "That email already has an account. Revoke this invitation instead.");
  }
  const channel = resolveChannel(deps, request.channel);
  const base = channel === null ? panelBase(deps, requestOrigin) : mailBase(deps, requestOrigin);
  const now = deps.now();
  const expiresAt = new Date(now + INVITATION_DAYS * MS_PER_DAY);
  const { token, tokenHash } = newToken();
  // Whoever issues the new link answers for it from now on.
  const updated = repo.updateInvitation(deps.db, id, {
    tokenHash,
    invitedBy: actor.user.id,
    expiresAt,
    delivery: channel === null ? "link" : "sending",
    channelName: channel?.name ?? null,
    sentAt: null,
    deliveryError: null,
  });
  if (updated === undefined) {
    throw notFound("This invitation does not exist.");
  }
  deps.actions.record({
    type: "auth.invitation-resend",
    title: `Send the invitation for ${updated.email} again`,
    actorEmail: actor.user.email,
  });

  const action =
    channel === null
      ? null
      : startSending(
          deps,
          actor,
          { channel, language: request.language, inviter: actor.user.email, panel: new URL(base).host },
          [
            {
              id,
              email: updated.email,
              role: userRole.parse(updated.role),
              tokenHash,
              link: linkFor(base, token),
              expiresAt,
            },
          ],
        );
  const row = repo.findInvitation(deps.db, id) ?? updated;
  return {
    invitation: toInvitation(row, actor.user.email, now),
    link: channel === null ? linkFor(base, token) : null,
    action: action === null ? null : toActionEntry(action),
  };
}

export function revokeInvitation(deps: AppDeps, actor: SessionPrincipal, id: string): void {
  const current = repo.findInvitation(deps.db, id);
  if (current === undefined) {
    throw notFound("This invitation does not exist.");
  }
  repo.deleteInvitation(deps.db, id);
  deps.actions.record({
    type: "auth.invitation-revoke",
    title: `Revoke the invitation for ${current.email}`,
    actorEmail: actor.user.email,
  });
}

/** The invitation a token opens, if it still can: unused, unexpired, and sent by an administrator in use. */
function findUsable(deps: AppDeps, token: string) {
  if (!TOKEN_PATTERN.test(token)) {
    return null;
  }
  const found = repo.findByTokenHash(deps.db, hashToken(token));
  if (
    found === undefined ||
    found.invitation.expiresAt.getTime() <= deps.now() ||
    !canStillInvite(found.inviter)
  ) {
    return null;
  }
  return found;
}

/** Wrong links count against the address that tries them, as wrong passwords do. */
function reserveAttempt(deps: AppDeps, meta: RequestMeta) {
  return deps.rateLimiter.consume([{ key: `invitation:${meta.ip}`, rule: deps.authLimits.loginPerAddress }]);
}

export function checkInvitation(deps: AppDeps, token: string, meta: RequestMeta): InvitationPreview {
  const attempt = reserveAttempt(deps, meta);
  const found = findUsable(deps, token);
  if (found === null) {
    throw invitationInvalid();
  }
  attempt.refund();
  return {
    email: found.invitation.email,
    role: userRole.parse(found.invitation.role),
    invitedBy: found.inviter.name === "" ? found.inviter.email : found.inviter.name,
    expiresAt: found.invitation.expiresAt.toISOString(),
  };
}

/** Creates the account the invitation describes, uses the link up, and signs the new account in. */
export async function acceptInvitation(
  deps: AppDeps,
  input: AcceptInvitationRequest,
  meta: RequestMeta,
): Promise<SignedIn> {
  const attempt = reserveAttempt(deps, meta);
  const found = findUsable(deps, input.token);
  if (found === null) {
    throw invitationInvalid();
  }

  const passwordHash = await hashPassword(input.password);
  const timestamp = new Date(deps.now());
  const userId = nanoid();

  const { token, user } = deps.db.transaction(
    (tx) => {
      // Read again after the slow hash: the link may have been used, replaced or taken back meanwhile.
      const again = repo.findByTokenHash(tx, found.invitation.tokenHash);
      if (
        again === undefined ||
        again.invitation.expiresAt.getTime() <= deps.now() ||
        !canStillInvite(again.inviter)
      ) {
        throw invitationInvalid();
      }
      const invitation = again.invitation;
      if (accessRepo.findUserByEmail(tx, invitation.email) !== undefined) {
        throw conflict("email_taken", "That email is already in use.");
      }
      // A project deleted since the invitation was sent is simply not part of what it gives.
      const existing = accessRepo.existingProjects(
        tx,
        invitation.projects.map((grant) => grant.project),
      );
      const grants =
        invitation.role === "admin" ? [] : invitation.projects.filter((grant) => existing.has(grant.project));
      const created = accessRepo.insertUser(tx, {
        id: userId,
        email: invitation.email,
        name: input.name,
        passwordHash,
        role: invitation.role,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      accessRepo.replaceMemberships(tx, userId, grants, timestamp);
      repo.deleteInvitation(tx, invitation.id);
      const session = insertSession(tx, {
        userId,
        persistent: false,
        secure: meta.secure,
        ip: meta.ip === UNKNOWN_IP ? null : meta.ip,
        userAgent: meta.userAgent,
        now: deps.now(),
      });
      return { token: session.token, user: created };
    },
    { behavior: "immediate" },
  );

  attempt.refund();
  deps.actions.record({
    type: "auth.invitation-accept",
    title: `Accepted the invitation from ${found.inviter.email}`,
    actorEmail: user.email,
  });
  return {
    token,
    persistent: false,
    state: {
      status: "signed-in",
      user: toSessionUser(user),
      twoFactorSetupRequired: needsTwoFactorSetup(deps.db, user),
    },
  };
}

/** E-mails that were waiting when the panel stopped can't go out any more: their links were in memory. */
export function concludeInterruptedSends(deps: Pick<AppDeps, "db">): void {
  repo.failInterruptedSends(deps.db, INTERRUPTED);
}
