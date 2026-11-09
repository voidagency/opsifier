import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { BoxIdeAccess, BoxIdeStatus, IssuedBoxIdeToken } from "@opsifier/contract";
import type { AppDeps } from "../../../core/context";
import type { DbHandle } from "../../../core/db";
import { isBoxRecord, requireBox, saveBox } from "../../box/service";
import type { StoredBox, StoredIdeToken } from "../../box/spec";
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

/** Off means off: whatever token existed goes with it, so turning it back on does not bring it back. */
export function setBoxIdeEnabled(
  deps: AppDeps,
  target: ServiceTarget,
  enabled: boolean,
  actorEmail: string | undefined,
): BoxIdeStatus {
  saveBox(deps, target, (box) => ({
    ...box,
    ide: { enabled, token: enabled ? box.ide.token : null },
  }));
  record(deps, target, actorEmail, enabled ? "Turn on the IDE" : "Turn off the IDE and end its tokens");
  return getBoxIdeStatus(deps, target);
}

/** Replaces the token, ending the one before it at once. The new one is shown here and nowhere else. */
export function issueBoxIdeToken(
  deps: AppDeps,
  target: ServiceTarget,
  issuerId: string,
  expiresInHours: number,
  actorEmail: string | undefined,
): IssuedBoxIdeToken {
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

export type IdeTokenVerdict = "valid" | "expired" | "refused";

/**
 * Whether this token opens this box's IDE now. Asked of the request's own values, so nothing about
 * another service, another credential or the time an earlier check ran can change the answer.
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
  return Date.parse(ide.token.expiresAt) <= deps.now() ? "expired" : "valid";
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
