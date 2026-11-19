import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { BoxIdeAccess, BoxIdeStatus, IssuedBoxIdeToken } from "@opsifier/contract";
import type { AppDeps } from "../../../core/context";
import type { DbHandle } from "../../../core/db";
import { requireHostAccessNow } from "../../access/guard";
import { type Access, accountCanReachHost } from "../../access/rules";
import { isBoxRecord, requireBox, saveBox } from "../../box/service";
import type { StoredBox, StoredIdeToken } from "../../box/spec";
import { anyTaskReachesServer, reachesServer } from "../../services/reach";
import { findService, listServiceRecords, saveServiceSpec } from "../../services/repo";
import type { ServiceTarget } from "../../services/service";

const HOUR_MS = 3_600_000;

const hashToken = (token: string): Buffer => createHash("sha256").update(token).digest();

const newToken = (): string => randomBytes(32).toString("hex");

function accessOf(ide: StoredBox["ide"], now: number): BoxIdeAccess {
  if (!ide.enabled) {
    return "off";
  }
  if (ide.token === null) {
    return "no_token";
  }
  return Date.parse(ide.token.expiresAt) <= now ? "expired" : "open";
}

const idePath = (target: ServiceTarget): string => `/ide/${target.projectName}/${target.serviceName}`;

export function getBoxIdeStatus(deps: AppDeps, target: ServiceTarget): BoxIdeStatus {
  const { ide } = requireBox(deps, target).spec.box;
  return {
    enabled: ide.enabled,
    access: accessOf(ide, deps.now()),
    createdAt: ide.token?.createdAt ?? null,
    expiresAt: ide.token?.expiresAt ?? null,
    path: idePath(target),
  };
}

function record(deps: AppDeps, target: ServiceTarget, actorEmail: string | undefined, what: string): void {
  deps.actions.record({
    type: "box.ide-access",
    title: `${what} for ${target.projectName}/${target.serviceName}`,
    ...target,
    actorEmail,
  });
}

/**
 * Off means off: whatever token existed goes with it, so turning it back on does not bring it back.
 * The workspace is what the box runs, live in its task, so turning the IDE on is held to the box's own
 * rule and to what that task was given.
 */
export async function setBoxIdeEnabled(
  deps: AppDeps,
  target: ServiceTarget,
  enabled: boolean,
  actorEmail: string | undefined,
  access: Access,
): Promise<BoxIdeStatus> {
  if (enabled) {
    await requireHostAccessNow(deps, access, target, requireBox(deps, target));
  }
  saveBox(deps, target, (box) => ({
    ...box,
    ide: { enabled, token: enabled ? box.ide.token : null },
  }));
  record(deps, target, actorEmail, enabled ? "Turn on the IDE" : "Turn off the IDE and end its tokens");
  return getBoxIdeStatus(deps, target);
}

/** Replaces the token, ending the one before it at once. The new one is shown here and nowhere else. */
export async function issueBoxIdeToken(
  deps: AppDeps,
  target: ServiceTarget,
  issuerId: string,
  expiresInHours: number,
  actorEmail: string | undefined,
  access: Access,
): Promise<IssuedBoxIdeToken> {
  await requireHostAccessNow(deps, access, target, requireBox(deps, target));
  const token = newToken();
  const now = deps.now();
  const stored: StoredIdeToken = {
    hash: hashToken(token).toString("hex"),
    createdBy: issuerId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiresInHours * HOUR_MS).toISOString(),
  };
  saveBox(deps, target, (box) => ({ ...box, ide: { enabled: true, token: stored } }));
  record(deps, target, actorEmail, "Issue a new IDE token");
  return { ...getBoxIdeStatus(deps, target), token };
}

/** Whoever holds the token can no longer get in. */
export function revokeBoxIdeToken(
  deps: AppDeps,
  target: ServiceTarget,
  actorEmail: string | undefined,
): BoxIdeStatus {
  saveBox(deps, target, (box) => ({ ...box, ide: { ...box.ide, token: null } }));
  record(deps, target, actorEmail, "Revoke the IDE token");
  return getBoxIdeStatus(deps, target);
}

export type IdeTokenVerdict = "valid" | "expired" | "refused" | "reaches_server";

/**
 * Whether this token opens this box's IDE now. Asked of the request's own values, so nothing about
 * another service, another credential or the time an earlier check ran can change the answer. In a box
 * that reaches the server, a right token only opens it while the account that issued it could still
 * have, so one issued before the box was given that access stops working there.
 */
export function checkBoxIdeToken(
  deps: Pick<AppDeps, "db" | "now">,
  target: ServiceTarget,
  token: string,
): IdeTokenVerdict {
  const record = findService(deps.db, target.projectName, target.serviceName);
  if (record === undefined || !isBoxRecord(record)) {
    return "refused";
  }
  const { ide } = record.spec.box;
  if (!ide.enabled || ide.token === null) {
    return "refused";
  }
  const expected = Buffer.from(ide.token.hash, "hex");
  const presented = hashToken(token);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    return "refused";
  }
  if (Date.parse(ide.token.expiresAt) <= deps.now()) {
    return "expired";
  }
  const issuer = ide.token.createdBy;
  return reachesServer(record) && (issuer === null || !accountCanReachHost(deps.db, issuer))
    ? "reaches_server"
    : "valid";
}

/**
 * Whether a right token must still be turned away because the box's running task reaches the server,
 * through a mount or a capability taken out of the settings that it keeps until the next deploy, and
 * whoever issued the token could not have opened the IDE there.
 */
export async function ideTaskReachesServer(
  deps: Pick<AppDeps, "db" | "docker" | "config">,
  target: ServiceTarget,
): Promise<boolean> {
  const record = findService(deps.db, target.projectName, target.serviceName);
  if (record === undefined || !isBoxRecord(record)) {
    return false;
  }
  const issuer = record.spec.box.ide.token?.createdBy ?? null;
  if (issuer !== null && accountCanReachHost(deps.db, issuer)) {
    return false;
  }
  return anyTaskReachesServer(deps, target);
}

/**
 * Called inside the transaction that changes an account, as a deployment token is. A token was handed
 * to that person, so it goes when they lose the rights they had when it was issued.
 */
export function revokeBoxIdeTokensOfAccount(db: DbHandle, userId: string, now: Date): void {
  for (const record of listServiceRecords(db)) {
    const box = record.spec.box;
    if (box !== null && box.ide.token?.createdBy === userId) {
      saveServiceSpec(
        db,
        record.projectName,
        record.name,
        { ...record.spec, box: { ...box, ide: { ...box.ide, token: null } } },
        now,
      );
    }
  }
}
