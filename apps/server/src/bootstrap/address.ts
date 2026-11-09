import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../core/config";
import { openDatabase } from "../core/db";
import { users } from "../core/db/schema";
import { createSecrets } from "../core/secrets";
import {
  type Credentials,
  NamesServiceError,
  registerServer,
  releaseServer,
} from "../features/opsifier-address/client";
import {
  type AddressChallenge,
  addressSecretPath,
  writeAddressSecret,
} from "../features/opsifier-address/proxy-env";
import {
  ADDRESS_SECRET_CONTEXT,
  forgetAddress,
  readAddress,
  saveAddress,
} from "../features/opsifier-address/repo";
import type { RegisteredAddress } from "./clean-setup";

/**
 * Registers the server during `setup`, or finds the address it already has. The panel isn't running on a
 * fresh install, so this is the one thing here that opens the database itself. On an existing install
 * the panel's own version owns the schema, so this reads and writes one row and migrates nothing.
 */
export interface SetupAddress {
  /** Resolves to the address to use. Null means sslip.io. Whatever goes wrong must end up as null. */
  ensure(input: { optedOut: boolean; log(line: string): void }): Promise<AddressForProxy | null>;
}

export interface AddressForProxy {
  domain: string;
  challenge: AddressChallenge;
}

const CALL_HOME =
  "It is this server's only call home: the registration and a daily heartbeat, and nothing else.";

interface SetupConfig {
  namesUrl: Config["namesUrl"];
  databaseFile: Config["databaseFile"];
  secretKeyFile: Config["secretKeyFile"];
  dataDir: Config["dataDir"];
}

function openForSetup(config: SetupConfig) {
  return existsSync(config.databaseFile)
    ? openDatabase(config.databaseFile, null)
    : openDatabase(config.databaseFile);
}

const describeFailure = (error: unknown): string =>
  error instanceof NamesServiceError ? error.message : "The address could not be stored.";

export function createSetupAddress(config: SetupConfig): SetupAddress {
  return {
    async ensure({ optedOut, log }) {
      const traefikDir = join(config.dataDir, "traefik");
      const forProxy = (id: string, domain: string, namesUrl: string): AddressForProxy => ({
        domain,
        challenge: { namesUrl, id, secretFile: addressSecretPath(traefikDir) },
      });

      const handle = openForSetup(config);
      try {
        const existing = readAddress(handle.db);
        if (existing?.status === "registered") {
          if (config.namesUrl === null) {
            return null;
          }
          const secrets = createSecrets(config.secretKeyFile, { allowCreate: false });
          await writeAddressSecret(traefikDir, secrets.unseal(existing.sealedSecret, ADDRESS_SECRET_CONTEXT));
          log(`Address: keeping ${existing.domain}. Release it in Settings to go back to sslip.io.`);
          return forProxy(existing.id, existing.domain, config.namesUrl);
        }
        if (existing?.status === "off") {
          log("Address: off, so generated names use sslip.io.");
          return null;
        }
        if (optedOut || config.namesUrl === null) {
          const reason = optedOut ? "--no-opsifier-address" : "OPSIFIER_NAMES_URL is off";
          log(`Address: not registering this server (${reason}), so generated names use sslip.io.`);
          if (optedOut) {
            saveAddress(handle.db, { status: "off", at: new Date().toISOString() }, new Date());
          }
          return null;
        }

        const hasUsers = handle.db.select({ id: users.id }).from(users).limit(1).get() !== undefined;
        const secrets = createSecrets(config.secretKeyFile, { allowCreate: !hasUsers });
        const registration = await registerServer(config.namesUrl);
        const credentials: Credentials = { id: registration.id, secret: registration.secret };
        await writeAddressSecret(traefikDir, credentials.secret);
        const now = new Date();
        saveAddress(
          handle.db,
          {
            status: "registered",
            id: registration.id,
            domain: registration.domain,
            sealedSecret: secrets.seal(registration.secret, ADDRESS_SECRET_CONTEXT),
            ip: registration.ip,
            registeredAt: now.toISOString(),
            lastHeartbeatAt: now.toISOString(),
            health: "ok",
          },
          now,
        );
        log(
          `Address: ${registration.domain} (${registration.ip}), from ${new URL(config.namesUrl).host}. ${CALL_HOME} Turn it off with --no-opsifier-address.`,
        );
        return forProxy(registration.id, registration.domain, config.namesUrl);
      } catch (error) {
        // A failure here is never a failure of the install: generated names simply stay on sslip.io.
        log(`Address: could not register (${describeFailure(error)}), so generated names use sslip.io.`);
        return null;
      } finally {
        handle.close();
      }
    },
  };
}

/** Whether anyone has claimed this panel. A database that exists but can't be read throws. */
export function panelHasAccounts(databaseFile: string): boolean {
  if (!existsSync(databaseFile)) {
    return false;
  }
  const handle = openDatabase(databaseFile, null);
  try {
    const hasTable =
      handle.db.$client
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'")
        .get() !== undefined;
    return hasTable && handle.db.select({ id: users.id }).from(users).limit(1).get() !== undefined;
  } finally {
    handle.close();
  }
}

/**
 * The address a setup registered no earlier than `since`, for undoing that setup. Older ones were there
 * before it, so they stay. Releasing is best effort: an address nobody heartbeats expires by itself.
 */
export function addressRegisteredSince(config: SetupConfig, since: string): RegisteredAddress | null {
  if (!existsSync(config.databaseFile)) {
    return null;
  }
  const handle = openDatabase(config.databaseFile, null);
  try {
    const stored = readAddress(handle.db);
    if (stored?.status !== "registered" || stored.registeredAt < since) {
      return null;
    }
    const { domain, id, sealedSecret } = stored;
    return {
      domain,
      release: async (log) => {
        if (config.namesUrl !== null) {
          try {
            const secrets = createSecrets(config.secretKeyFile, { allowCreate: false });
            await releaseServer(config.namesUrl, {
              id,
              secret: secrets.unseal(sealedSecret, ADDRESS_SECRET_CONTEXT),
            });
          } catch (error) {
            log(
              `The address service could not be told (${describeFailure(error)}). The address expires by itself after 90 days without a heartbeat.`,
            );
          }
        }
        rmSync(addressSecretPath(join(config.dataDir, "traefik")), { force: true });
        const handleForWrite = openDatabase(config.databaseFile, null);
        try {
          forgetAddress(handleForWrite.db);
        } finally {
          handleForWrite.close();
        }
      },
    };
  } finally {
    handle.close();
  }
}
