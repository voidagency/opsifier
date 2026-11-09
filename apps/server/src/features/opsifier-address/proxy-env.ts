import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppDeps } from "../../core/context";
import { readAddress } from "./repo";

/**
 * What Traefik needs to answer the DNS challenge. The secret reaches it through a file: an environment
 * variable would put it in the Swarm service's spec, where `docker service inspect` shows it to anyone.
 */

export const ADDRESS_SECRET_FILE = "opsifier-address.secret";

export interface AddressChallenge {
  /** The address service's base URL. */
  namesUrl: string;
  id: string;
  /** Where Traefik finds the secret, as its container sees it. */
  secretFile: string;
}

export const addressSecretPath = (traefikDir: string): string => join(traefikDir, ADDRESS_SECRET_FILE);

/** What `renderProxyEnv` adds, or null with no address or with the service turned off. */
export function addressChallengeFor(
  deps: Pick<AppDeps, "db" | "config">,
  directory: string,
): AddressChallenge | null {
  const address = readAddress(deps.db);
  if (address?.status !== "registered" || deps.config.namesUrl === null) {
    return null;
  }
  return { namesUrl: deps.config.namesUrl, id: address.id, secretFile: addressSecretPath(directory) };
}

/** The static configuration of the DNS resolver, and the variables its `httpreq` provider reads. */
export function addressChallengeEnv(
  directory: string,
  email: string | null,
  challenge: AddressChallenge,
): Record<string, string> {
  const resolver = "TRAEFIK_CERTIFICATESRESOLVERS_OPSIFIER_ACME";
  return {
    [`${resolver}_STORAGE`]: `${directory}/acme.json`,
    [`${resolver}_DNSCHALLENGE_PROVIDER`]: "httpreq",
    // A local check can pass while Let's Encrypt's other vantage points still see nothing: a real
    // issuance failed that way. Route 53 reaches all its servers within about a minute.
    [`${resolver}_DNSCHALLENGE_PROPAGATION_DELAYBEFORECHECKS`]: "90s",
    ...(email === null ? {} : { [`${resolver}_EMAIL`]: email }),
    HTTPREQ_ENDPOINT: `${challenge.namesUrl}/v1/acme`,
    HTTPREQ_USERNAME: challenge.id,
    HTTPREQ_PASSWORD_FILE: challenge.secretFile,
    // Route 53 takes up to a minute to reach all its servers, which is httpreq's default limit.
    HTTPREQ_PROPAGATION_TIMEOUT: "300",
    HTTPREQ_POLLING_INTERVAL: "5",
  };
}

/** The file only Traefik and root read. Written whole, so it is never seen half done. */
export async function writeAddressSecret(traefikDir: string, secret: string): Promise<void> {
  await mkdir(traefikDir, { recursive: true, mode: 0o755 });
  const path = addressSecretPath(traefikDir);
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(secret, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function removeAddressSecret(traefikDir: string): Promise<void> {
  await rm(addressSecretPath(traefikDir), { force: true });
}
