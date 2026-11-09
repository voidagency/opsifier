import {
  type ChangeCredentialsRequest,
  type LoginRequest,
  type SessionState,
  type SessionUser,
  type SetupRequest,
  type TwoFactorDisable,
  type TwoFactorSetup,
  twoFactorRequiredCode,
} from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  buildOtpauthUri,
  deleteOtherSessions,
  deleteSessionByToken,
  ensureSetupToken,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashRecoveryCode,
  insertSession,
  matchTotpStep,
  type Principal,
  purgeExpiredSessions,
  type RateLimitReservation,
  type RequestMeta,
  removeSetupToken,
  toSessionUser,
  UNKNOWN_IP,
  type UserRow,
  verifyAgainstDecoy,
  verifyPassword,
  verifySetupToken,
} from "../../core/auth";
import type { AppDeps } from "../../core/context";
import type { DbHandle } from "../../core/db";
import { apiTokens } from "../../core/db/schema";
import { AppError, badRequest, conflict, forbidden, unauthorized } from "../../core/errors";
import { revokeTriggersOfAccount } from "../service-tabs/deployments/trigger";
import * as repo from "./repo";

export interface SignedIn {
  token: string;
  persistent: boolean;
  state: SessionState;
}

type SessionPrincipal = Extract<Principal, { kind: "session" }>;

const WRONG_CREDENTIALS = "Those credentials are not correct.";
const WRONG_CODE = "That code is not valid.";
const WRONG_SETUP_CODE = "That setup code is not valid.";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A password of only spaces passes a length check and is still an empty credential. */
function assertUsablePassword(field: string, password: string): void {
  if (password.trim() === "") {
    throw badRequest("validation_failed", "Some fields need attention.", {
      [field]: "Must not be blank",
    });
  }
}

const activeTotpContext = (userId: string) => `totp:${userId}`;
const pendingTotpContext = (userId: string) => `totp-pending:${userId}`;

/** Long enough to scan a code. An abandoned setup goes inert instead of lingering. */
const PENDING_TOTP_TTL_MS = 15 * 60 * 1000;

interface PendingTotp {
  secret: string;
  expiresAt: number;
}

/**
 * Until someone has claimed the panel, setting it up takes a token only the people who run the
 * server can read. Once a user exists it has no purpose left, so a stale one is cleared away.
 */
export function prepareSetupToken({ db, config, logger }: Pick<AppDeps, "db" | "config" | "logger">): void {
  if (repo.hasAnyUser(db)) {
    removeSetupToken(config.setupTokenFile);
    return;
  }
  const token = ensureSetupToken(config.setupTokenFile);
  // In the message rather than a field: a field named `token` would be redacted from the log.
  logger.warn(`This panel has no administrator yet. Open /setup?token=${token} to create one.`);
}

export function createAuthService(deps: AppDeps) {
  const { db, config, logger, secrets, actions, realtime, rateLimiter, authLimits, now } = deps;

  function reserveSensitive(userId: string): RateLimitReservation {
    return rateLimiter.consume([{ key: `sensitive:${userId}`, rule: authLimits.sensitivePerUser }]);
  }

  function openSession(handle: DbHandle, user: UserRow, persistent: boolean, meta: RequestMeta): string {
    return insertSession(handle, {
      userId: user.id,
      persistent,
      secure: meta.secure,
      ip: meta.ip === UNKNOWN_IP ? null : meta.ip,
      userAgent: meta.userAgent,
      now: now(),
    }).token;
  }

  function verifyActiveCode(user: UserRow, code: string): boolean {
    if (user.totpSecret === null) {
      return false;
    }
    const secret = secrets.unseal(user.totpSecret, activeTotpContext(user.id));
    const step = matchTotpStep(secret, code, { now: now(), afterStep: user.totpLastStep });
    return step !== null && repo.consumeTotpStep(db, user.id, step);
  }

  function verifyRecoveryCode(user: UserRow, code: string): boolean {
    return repo.consumeRecoveryCode(db, user.id, hashRecoveryCode(code));
  }

  async function assertCurrentPassword(user: UserRow, password: string): Promise<void> {
    if (!(await verifyPassword(password, user.passwordHash))) {
      throw badRequest("invalid_current_password", "The current password is not correct.", {
        currentPassword: "Incorrect password",
      });
    }
  }

  return {
    sessionState(principal: Principal | null): SessionState {
      if (!repo.hasAnyUser(db)) {
        return { status: "needs-setup" };
      }
      return principal === null
        ? { status: "signed-out" }
        : { status: "signed-in", user: toSessionUser(principal.user) };
    },

    async setup(input: SetupRequest, meta: RequestMeta): Promise<SignedIn> {
      assertUsablePassword("password", input.password);
      const alreadySetUp = () => conflict("already_set_up", "This panel has already been set up.");

      if (repo.hasAnyUser(db)) {
        throw alreadySetUp();
      }
      rateLimiter.consume([{ key: `setup:${meta.ip}`, rule: authLimits.loginPerAddress }]);

      if (!verifySetupToken(config.setupTokenFile, input.token)) {
        throw forbidden("invalid_setup_token", WRONG_SETUP_CODE, { token: WRONG_SETUP_CODE });
      }

      // Hashing yields to the event loop, so another setup can reach this point too. The
      // transaction below is what lets only one of them through.
      const passwordHash = await hashPassword(input.password);
      const timestamp = new Date(now());

      const signedIn = db.transaction(
        (tx) => {
          if (repo.hasAnyUser(tx)) {
            throw alreadySetUp();
          }
          const user = repo.insertUser(tx, {
            id: nanoid(),
            email: normalizeEmail(input.email),
            name: input.name,
            passwordHash,
            role: "admin",
            isOwner: true,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          const token = openSession(tx, user, false, meta);
          return { token, user };
        },
        { behavior: "immediate" },
      );

      // After the commit: if this fails the token is inert anyway, and the next boot removes it.
      try {
        removeSetupToken(config.setupTokenFile);
      } catch (error) {
        logger.error({ err: error }, "The used setup token could not be deleted");
      }

      actions.record({
        type: "auth.setup",
        title: "Created the administrator account",
        actorEmail: signedIn.user.email,
      });
      return {
        token: signedIn.token,
        persistent: false,
        state: { status: "signed-in", user: toSessionUser(signedIn.user) },
      };
    },

    async login(input: LoginRequest, meta: RequestMeta): Promise<SignedIn> {
      const email = normalizeEmail(input.email);
      const pairKey = `login:pair:${meta.ip}:${email}`;
      // Counted before the password is checked, so that concurrent guesses cannot race past.
      const attempt = rateLimiter.consume([
        { key: pairKey, rule: authLimits.loginPerAddressAndEmail },
        { key: `login:address:${meta.ip}`, rule: authLimits.loginPerAddress },
        { key: `login:email:${email}`, rule: authLimits.loginPerEmail },
      ]);

      const candidate = repo.findUserByEmail(db, email);
      if (candidate === undefined) {
        await verifyAgainstDecoy(input.password);
        throw unauthorized("invalid_credentials", WRONG_CREDENTIALS);
      }
      if (!(await verifyPassword(input.password, candidate.passwordHash))) {
        throw unauthorized("invalid_credentials", WRONG_CREDENTIALS);
      }

      // Re-read after the slow hash, so a password change or 2FA setup in the meantime counts.
      const user = repo.findUserById(db, candidate.id);
      if (user === undefined || user.passwordHash !== candidate.passwordHash || user.deactivatedAt !== null) {
        throw unauthorized("invalid_credentials", WRONG_CREDENTIALS);
      }

      let usedRecoveryCode = false;
      if (user.totpSecret !== null) {
        if (input.recoveryCode !== undefined) {
          if (!verifyRecoveryCode(user, input.recoveryCode)) {
            throw unauthorized("invalid_recovery_code", WRONG_CODE, { recoveryCode: WRONG_CODE });
          }
          usedRecoveryCode = true;
        } else if (input.code === undefined) {
          attempt.refund();
          throw new AppError(401, twoFactorRequiredCode, "Enter the code from your authenticator app.");
        } else if (!verifyActiveCode(user, input.code)) {
          throw unauthorized("invalid_two_factor_code", WRONG_CODE, { code: WRONG_CODE });
        }
      }

      attempt.forgive(pairKey);
      purgeExpiredSessions(db, now());
      const token = openSession(db, user, input.rememberMe, meta);
      const signedIn = usedRecoveryCode ? "Signed in with a recovery code" : "Signed in";
      actions.record({
        type: "auth.login",
        title: meta.ip === UNKNOWN_IP ? signedIn : `${signedIn} from ${meta.ip}`,
        actorEmail: user.email,
      });
      return {
        token,
        persistent: input.rememberMe,
        state: { status: "signed-in", user: toSessionUser(user) },
      };
    },

    /** Ends the session carried by the request. Safe to call with none. */
    logout(sessionToken: string | undefined): void {
      if (sessionToken === undefined) {
        return;
      }
      const sessionId = deleteSessionByToken(db, sessionToken);
      if (sessionId !== null) {
        realtime.disconnectSessions([sessionId]);
      }
    },

    async changeCredentials(
      principal: SessionPrincipal,
      input: ChangeCredentialsRequest,
    ): Promise<SessionUser> {
      assertUsablePassword("newPassword", input.newPassword);
      const { user } = principal;
      const attempt = reserveSensitive(user.id);

      if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
        throw badRequest("invalid_current_password", "The current password is not correct.", {
          currentPassword: "Incorrect password",
        });
      }

      const email = normalizeEmail(input.email);
      const passwordHash = await hashPassword(input.newPassword);

      const { updated, endedSessions } = db.transaction(
        (tx) => {
          const current = repo.findUserById(tx, user.id);
          if (current === undefined || current.passwordHash !== user.passwordHash) {
            throw conflict("credentials_changed", "These credentials were changed by another request.");
          }
          const holder = repo.findUserByEmail(tx, email);
          if (holder !== undefined && holder.id !== user.id) {
            throw conflict("email_taken", "That email is already in use.", { email: "Already in use" });
          }
          const updated = repo.updateCredentials(tx, user.id, {
            email,
            passwordHash,
            updatedAt: new Date(now()),
          });
          // Keys carry the account's authority, so changing how it signs in revokes them as well.
          tx.delete(apiTokens).where(eq(apiTokens.userId, user.id)).run();
          // Its rights haven't changed, so what it issued goes but what it could merely read stays.
          revokeTriggersOfAccount(tx, user.id, () => false, new Date(now()));
          return { updated, endedSessions: deleteOtherSessions(tx, user.id, principal.sessionId) };
        },
        { behavior: "immediate" },
      );

      attempt.refund();
      realtime.disconnectSessions(endedSessions);
      actions.record({
        type: "auth.credentials",
        title: "Changed account credentials",
        actorEmail: updated.email,
      });
      return toSessionUser(updated);
    },

    /**
     * Generates a setup secret and keeps it apart from the active one, so opening the dialog
     * and walking away never touches a working second factor. It takes the password: a session
     * on its own, stolen or left open, must not be able to lock the owner out with a new device.
     */
    async beginTwoFactor(principal: SessionPrincipal, currentPassword: string): Promise<TwoFactorSetup> {
      const { user } = principal;
      if (user.totpSecret !== null) {
        throw conflict("two_factor_already_enabled", "Two-factor authentication is already on.");
      }
      const attempt = reserveSensitive(user.id);
      await assertCurrentPassword(user, currentPassword);
      attempt.refund();

      const secret = generateTotpSecret();
      const pending: PendingTotp = { secret, expiresAt: now() + PENDING_TOTP_TTL_MS };
      repo.setPendingTotp(
        db,
        user.id,
        secrets.seal(JSON.stringify(pending), pendingTotpContext(user.id)),
        new Date(now()),
      );
      return { secret, otpauthUri: buildOtpauthUri(user.email, secret) };
    },

    /** The recovery codes in the result exist nowhere else: only their hashes are stored. */
    enableTwoFactor(
      principal: SessionPrincipal,
      code: string,
    ): { user: SessionUser; recoveryCodes: string[] } {
      const attempt = reserveSensitive(principal.user.id);
      const user = repo.findUserById(db, principal.user.id);
      if (user === undefined || user.totpSecret !== null) {
        throw conflict("two_factor_already_enabled", "Two-factor authentication is already on.");
      }
      if (user.totpPendingSecret === null) {
        throw conflict("two_factor_not_started", "Start the setup first.");
      }

      const pending = JSON.parse(
        secrets.unseal(user.totpPendingSecret, pendingTotpContext(user.id)),
      ) as PendingTotp;
      if (pending.expiresAt <= now()) {
        throw conflict("two_factor_not_started", "The setup expired. Start it again.");
      }

      const step = matchTotpStep(pending.secret, code, { now: now(), afterStep: null });
      if (step === null) {
        throw badRequest("invalid_two_factor_code", WRONG_CODE, { code: WRONG_CODE });
      }

      const timestamp = new Date(now());
      const sealedSecret = secrets.seal(pending.secret, activeTotpContext(user.id));
      const pendingSecret = user.totpPendingSecret;
      const recoveryCodes = generateRecoveryCodes();
      const updated = db.transaction(
        (tx) => {
          const activated = repo.activateTotp(tx, user.id, pendingSecret, sealedSecret, step, timestamp);
          if (activated === undefined) {
            throw conflict("two_factor_setup_changed", "The setup changed. Start again.");
          }
          repo.replaceRecoveryCodes(tx, user.id, recoveryCodes.map(hashRecoveryCode), timestamp);
          return activated;
        },
        { behavior: "immediate" },
      );

      attempt.refund();
      // Whoever else was signed in did not prove possession of the new factor.
      realtime.disconnectSessions(deleteOtherSessions(db, user.id, principal.sessionId));
      actions.record({
        type: "auth.two-factor",
        title: "Enabled two-factor authentication",
        actorEmail: user.email,
      });
      return { user: toSessionUser(updated), recoveryCodes };
    },

    async disableTwoFactor(principal: SessionPrincipal, input: TwoFactorDisable): Promise<SessionUser> {
      const attempt = reserveSensitive(principal.user.id);
      if (principal.user.totpSecret === null) {
        throw conflict("two_factor_not_enabled", "Two-factor authentication is not on.");
      }
      // Before any code is checked, so that a wrong password cannot use one up.
      await assertCurrentPassword(principal.user, input.currentPassword);

      // Re-read after the slow hash, so a code spent in the meantime counts as spent.
      const user = repo.findUserById(db, principal.user.id);
      if (user === undefined || user.totpSecret === null) {
        throw conflict("two_factor_not_enabled", "Two-factor authentication is not on.");
      }
      if (input.recoveryCode !== undefined) {
        if (!verifyRecoveryCode(user, input.recoveryCode)) {
          throw badRequest("invalid_recovery_code", WRONG_CODE, { recoveryCode: WRONG_CODE });
        }
      } else if (input.code === undefined || !verifyActiveCode(user, input.code)) {
        throw badRequest("invalid_two_factor_code", WRONG_CODE, { code: WRONG_CODE });
      }

      const updated = db.transaction(
        (tx) => {
          repo.deleteRecoveryCodes(tx, user.id);
          return repo.clearTotp(tx, user.id, new Date(now()));
        },
        { behavior: "immediate" },
      );
      attempt.refund();
      actions.record({
        type: "auth.two-factor",
        title: "Disabled two-factor authentication",
        actorEmail: user.email,
      });
      return toSessionUser(updated);
    },
  };
}
