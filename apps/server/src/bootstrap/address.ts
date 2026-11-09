import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../core/config";
import { openDatabase } from "../core/db";
import { users } from "../core/db/schema";
import { createSecrets } from "../core/secrets";
import { NamesServiceError, releaseServer } from "../features/opsifier-address/client";
import {
  type AddressChallenge,
  addressSecretPath,
  writeAddressSecret,
} from "../features/opsifier-address/proxy-env";
import { ADDRESS_SECRET_CONTEXT, forgetAddress, readAddress } from "../features/opsifier-address/repo";
import type { RegisteredAddress } from "./clean-setup";

/**
 * Puts back what the proxy needs for an address this server already has. `setup` never asks for one:
 * that is a request someone approves, made from Settings once the panel is running.
 */
export interface SetupAddress {
  /** Resolves to the address to use. Null means sslip.io. Whatever goes wrong must end up as null. */
  ensure(input: { log(line: string): void }): Promise<AddressForProxy | null>;
}

export interface AddressForProxy {
  domain: string;
  challenge: AddressChallenge;
}

interface SetupConfig {
  namesUrl: Config["namesUrl"];
  databaseFile: Config["databaseFile"];
  secretKeyFile: Config["secretKeyFile"];
  dataDir: Config["dataDir"];
}

const NO_ADDRESS = "Address: generated names use sslip.io. You can ask for a ready-made address in Settings.";

export function createSetupAddress(config: SetupConfig): SetupAddress {
  return {
    async ensure({ log }) {
      if (!existsSync(config.databaseFile)) {
        log(NO_ADDRESS);
        return null;
      }
      const handle = openDatabase(config.databaseFile, null);
      try {
        const existing = readAddress(handle.db);
        if (existing?.status === "registered" && config.namesUrl !== null) {
          const traefikDir = join(config.dataDir, "traefik");
          const secrets = createSecrets(config.secretKeyFile, { allowCreate: false });
          await writeAddressSecret(traefikDir, secrets.unseal(existing.sealedSecret, ADDRESS_SECRET_CONTEXT));
          log(`Address: keeping ${existing.domain}. Release it in Settings to go back to sslip.io.`);
          return {
            domain: existing.domain,
            challenge: {
              namesUrl: config.namesUrl,
              id: existing.id,
              secretFile: addressSecretPath(traefikDir),
            },
          };
        }
        log(NO_ADDRESS);
        return null;
      } catch {
        // A failure here is never a failure of the install: generated names simply stay on sslip.io.
        log("Address: the stored address could not be read, so generated names use sslip.io.");
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

const describeFailure = (error: unknown): string =>
  error instanceof NamesServiceError ? error.message : "The address could not be stored.";

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
