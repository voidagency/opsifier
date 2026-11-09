import { randomBytes } from "node:crypto";
import { hashPassword, revokeUserCredentials } from "../../core/auth";
import type { Config } from "../../core/config";
import { openDatabase } from "../../core/db";
import { revokeTriggersOfAccount } from "../service-tabs/deployments/trigger";
import * as repo from "./repo";

export class ResetPasswordError extends Error {
  override readonly name = "ResetPasswordError";
}

/**
 * For the person who has lost the way in. It runs on the server, through the panel's own image, with no
 * panel running: being able to reach this command is what proves the right to use it. Every session,
 * API key and deployment trigger of the account ends, so whoever had them no longer does.
 */
export async function resetPassword(
  config: Pick<Config, "databaseFile">,
  requestedEmail: string | undefined,
  options: { now?: () => number; open?: typeof openDatabase } = {},
): Promise<{ email: string; password: string }> {
  const now = options.now ?? Date.now;
  const handle = (options.open ?? openDatabase)(config.databaseFile);
  try {
    const user =
      requestedEmail === undefined
        ? repo.listUsers(handle.db).find((candidate) => candidate.isOwner)
        : repo.findUserByEmail(handle.db, requestedEmail.trim().toLowerCase());
    if (user === undefined) {
      throw new ResetPasswordError(
        requestedEmail === undefined
          ? "This panel has no account yet."
          : `No account uses ${requestedEmail}.`,
      );
    }

    const password = randomBytes(18).toString("base64url");
    const passwordHash = await hashPassword(password);
    handle.db.transaction(
      (tx) => {
        repo.updateUserRow(tx, user.id, { passwordHash, updatedAt: new Date(now()) });
        revokeUserCredentials(tx, user.id);
        revokeTriggersOfAccount(tx, user.id, () => false, new Date(now()));
      },
      { behavior: "immediate" },
    );
    return { email: user.email, password };
  } finally {
    handle.close();
  }
}
