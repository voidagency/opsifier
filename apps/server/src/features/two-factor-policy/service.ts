import type { TwoFactorPolicy, TwoFactorPolicyState } from "@opsifier/contract";
import { and, isNull, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Principal, UserRow } from "../../core/auth";
import type { AppDeps, AppEnv } from "../../core/context";
import type { DbHandle } from "../../core/db";
import { users } from "../../core/db/schema";
import { conflict, forbidden } from "../../core/errors";
import { assertOwner } from "../access/service";
import { getSetting, putSetting } from "../system/repo";

type SessionPrincipal = Extract<Principal, { kind: "session" }>;

const POLICY_KEY = "two_factor_policy";

/** What an account still without two-factor sign-in may call, from a browser, to turn it on. */
const SETUP_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/auth/two-factor/begin",
  "/api/v1/auth/two-factor/enable",
]);

export function twoFactorRequired(db: DbHandle): boolean {
  return (getSetting(db, POLICY_KEY) as Partial<TwoFactorPolicy> | undefined)?.required === true;
}

/** Whether this account has to turn on two-factor sign-in before it may do anything else. */
export function needsTwoFactorSetup(db: DbHandle, user: Pick<UserRow, "totpSecret">): boolean {
  return user.totpSecret === null && twoFactorRequired(db);
}

/**
 * While the owner requires two-factor sign-in, an account without it can only turn it on: anything
 * else it asks, from a browser or with one of its keys, is refused. Public paths answer as they would
 * for anyone, so signing in and out, and accepting an invitation, keep working.
 */
export function requireTwoFactorSetup(
  deps: Pick<AppDeps, "db">,
  isPublic: (path: string) => boolean,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (
      principal !== null &&
      !isPublic(c.req.path) &&
      !(principal.kind === "session" && SETUP_PATHS.has(c.req.path)) &&
      needsTwoFactorSetup(deps.db, principal.user)
    ) {
      throw forbidden(
        "two_factor_setup_required",
        principal.kind === "session"
          ? "This panel requires two-factor sign-in: turn it on for this account first."
          : "This panel requires two-factor sign-in, and the account behind this key hasn't turned it on.",
      );
    }
    return next();
  };
}

/** Accounts in use that would be kept to turning it on. */
function accountsWithout(db: DbHandle): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(users)
    .where(and(isNull(users.totpSecret), isNull(users.deactivatedAt)))
    .get();
  return Number(row?.count ?? 0);
}

export function readPolicy(deps: Pick<AppDeps, "db">, actor: SessionPrincipal): TwoFactorPolicyState {
  return {
    required: twoFactorRequired(deps.db),
    accountsWithout: accountsWithout(deps.db),
    canChange: actor.user.isOwner,
  };
}

/**
 * Only the owner decides, and only once their own account has it: requiring it of everyone while
 * lacking it would keep them to the setup page too.
 */
export function savePolicy(
  deps: Pick<AppDeps, "db" | "actions" | "now">,
  actor: SessionPrincipal,
  request: TwoFactorPolicy,
): TwoFactorPolicyState {
  assertOwner(actor);
  if (request.required && actor.user.totpSecret === null) {
    throw conflict("two_factor_first", "Turn on two-factor sign-in on your own account first.");
  }
  if (request.required !== twoFactorRequired(deps.db)) {
    putSetting(deps.db, POLICY_KEY, { required: request.required }, new Date(deps.now()));
    deps.actions.record({
      type: "auth.two-factor-policy",
      title: request.required
        ? "Require two-factor sign-in for every account"
        : "Stop requiring two-factor sign-in",
      actorEmail: actor.user.email,
    });
  }
  return readPolicy(deps, actor);
}
