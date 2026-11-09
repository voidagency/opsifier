import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpsifierAddressState, OpsifierAddressStatus } from "@opsifier/contract";
import { eq } from "drizzle-orm";
import type { AppDeps } from "../../core/context";
import { customDomains, domains } from "../../core/db/schema";
import { AppError, conflict } from "../../core/errors";
import { listCertificates } from "../certificates/service";
import { rewriteCustomRoutes } from "../domains/service";
import { PROXY_SERVICE } from "../projects/network";
import { defaultPanelDomain } from "../server/panel-host";
import { enqueueProxyRestart } from "../server/proxy";
import { generatedServiceBase, writePanelRoutes } from "../server/settings";
import { rehostCompanions } from "../service-tabs/companions/service";
import { rewriteAllRoutes } from "../service-tabs/domains/changes";
import { wildcardOf } from "./certificates";
import {
  type Credentials,
  NamesServiceError,
  type Registration,
  registerServer,
  releaseServer,
  sendHeartbeat,
} from "./client";
import { addressSecretPath, removeAddressSecret, writeAddressSecret } from "./proxy-env";
import { ADDRESS_SECRET_CONTEXT, type RegisteredAddress, readAddress, saveAddress } from "./repo";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTION_TYPE = "server.address";
/** Traefik's own secret file, as the panel sees the proxy's folder. */
const traefikDir = (deps: AppDeps): string => join(deps.config.dataDir, "traefik");

const statusOf = (address: RegisteredAddress): OpsifierAddressStatus => {
  switch (address.health) {
    case "ok":
      return "active";
    case "unreachable":
      return "unreachable";
    case "lost":
      return "lost";
    case "disabled":
      return "disabled";
  }
};

async function certificateStateOf(
  deps: AppDeps,
  domain: string,
): Promise<OpsifierAddressState["certificate"]> {
  const wildcard = wildcardOf(domain);
  const certificate = (await listCertificates(deps)).find(({ domain: name }) => name === wildcard);
  if (certificate === undefined || certificate.state === "unreadable") {
    return "pending";
  }
  return certificate.state === "valid" ? "issued" : certificate.state;
}

export async function getAddressState(deps: AppDeps): Promise<OpsifierAddressState> {
  const available = deps.config.namesUrl !== null;
  const address = readAddress(deps.db);
  if (address?.status !== "registered") {
    const panel = defaultPanelDomain(deps);
    return {
      status: "off",
      available,
      domain: null,
      wildcard: null,
      certificate: null,
      panelUrl: panel === null ? null : `https://${panel}`,
      ip: null,
      registeredAt: null,
      lastHeartbeatAt: null,
    };
  }
  return {
    status: statusOf(address),
    available,
    domain: address.domain,
    wildcard: wildcardOf(address.domain),
    certificate: await certificateStateOf(deps, address.domain),
    panelUrl: `https://panel.${address.domain}`,
    ip: address.ip,
    registeredAt: address.registeredAt,
    lastHeartbeatAt: address.lastHeartbeatAt,
  };
}

/** One registration or release at a time, so the two can't finish out of order. */
const inProgress = new WeakSet<AppDeps>();

async function exclusive<T>(deps: AppDeps, work: () => Promise<T>): Promise<T> {
  if (inProgress.has(deps)) {
    throw conflict("address_busy", "Another change to the address is already in progress.");
  }
  inProgress.add(deps);
  try {
    return await work();
  } finally {
    inProgress.delete(deps);
  }
}

function serviceError(error: unknown): AppError {
  if (error instanceof NamesServiceError) {
    return new AppError(502, "address_service_failed", error.message);
  }
  return new AppError(502, "address_service_failed", "The address service could not be used.");
}

function credentialsOf(deps: AppDeps, address: RegisteredAddress): Credentials | null {
  try {
    return { id: address.id, secret: deps.secrets.unseal(address.sealedSecret, ADDRESS_SECRET_CONTEXT) };
  } catch {
    deps.logger.warn("The address secret could not be read");
    return null;
  }
}

/** Telling the service is a courtesy: what happens here doesn't depend on it being reachable. */
async function tellServiceReleased(deps: AppDeps, address: RegisteredAddress): Promise<void> {
  const credentials = credentialsOf(deps, address);
  if (deps.config.namesUrl === null || credentials === null) {
    return;
  }
  try {
    await releaseServer(deps.config.namesUrl, credentials);
  } catch (error) {
    deps.logger.warn({ err: error }, "Could not tell the address service this address was released");
  }
}

/** Hostnames follow the address. Otherwise everything under an address that no longer resolves is dead. */
async function moveHosts(deps: AppDeps, from: string, to: string): Promise<void> {
  const suffix = `.${from}`;
  const moved = (host: string) => `${host.slice(0, -suffix.length)}.${to}`;
  const updatedAt = new Date(deps.now());
  const tables = [domains, customDomains] as const;
  for (const table of tables) {
    for (const row of deps.db.select().from(table).all()) {
      if (!row.host.endsWith(suffix)) {
        continue;
      }
      try {
        deps.db
          .update(table)
          .set({ host: moved(row.host), updatedAt })
          .where(eq(table.id, row.id))
          .run();
      } catch (error) {
        deps.logger.warn({ err: error, host: row.host }, "Could not move a hostname to the new address");
      }
    }
  }
  await rehostCompanions(deps, suffix, `.${to}`);
}

async function refreshRoutes(deps: AppDeps): Promise<void> {
  await writePanelRoutes(deps);
  await rewriteAllRoutes(deps);
  await rewriteCustomRoutes(deps);
}

/** What Traefik's environment says about the address, against what is stored now. */
async function proxyIsCurrent(deps: AppDeps, wanted: string | null): Promise<boolean> {
  const proxy = await deps.docker.inspectService(PROXY_SERVICE);
  if (proxy === null) {
    return true;
  }
  const entry = proxy.spec.TaskTemplate.ContainerSpec.Env?.find((line) =>
    line.startsWith("HTTPREQ_USERNAME="),
  );
  return (entry === undefined ? null : entry.slice("HTTPREQ_USERNAME=".length)) === wanted;
}

/** The resolver lives in Traefik's static configuration, so only a restart can change it. */
async function restartProxyIfBehind(deps: AppDeps, actorEmail: string | undefined): Promise<void> {
  const address = readAddress(deps.db);
  const wanted = address?.status === "registered" && deps.config.namesUrl !== null ? address.id : null;
  if (!(await proxyIsCurrent(deps, wanted))) {
    enqueueProxyRestart(deps, actorEmail, "the server's address changed");
  }
}

function record(deps: AppDeps, title: string, actorEmail: string | undefined): void {
  deps.actions.record({ type: ACTION_TYPE, title, actorEmail });
}

function storedAddress(deps: AppDeps, registration: Registration): RegisteredAddress {
  const now = new Date(deps.now()).toISOString();
  return {
    status: "registered",
    id: registration.id,
    domain: registration.domain,
    sealedSecret: deps.secrets.seal(registration.secret, ADDRESS_SECRET_CONTEXT),
    ip: registration.ip,
    registeredAt: now,
    // The first heartbeat comes a day after this one, which was as good as one.
    lastHeartbeatAt: now,
    health: "ok",
  };
}

/**
 * Registers this server, or gives it a new address in place of the one it had. The old one is only let
 * go of once the new one exists, so a failure here leaves the server exactly as it was.
 */
export async function registerAddress(
  deps: AppDeps,
  actorEmail: string | undefined,
): Promise<OpsifierAddressState> {
  return exclusive(deps, async () => {
    const { namesUrl } = deps.config;
    if (namesUrl === null) {
      throw conflict("address_service_off", "This server is set to never call the address service.");
    }
    const previous = readAddress(deps.db);
    let registration: Registration;
    try {
      registration = await registerServer(namesUrl);
    } catch (error) {
      throw serviceError(error);
    }

    await writeAddressSecret(traefikDir(deps), registration.secret);
    saveAddress(deps.db, storedAddress(deps, registration), new Date(deps.now()));
    if (previous?.status === "registered") {
      await moveHosts(deps, previous.domain, registration.domain);
      await tellServiceReleased(deps, previous);
    }
    await refreshRoutes(deps);
    await restartProxyIfBehind(deps, actorEmail);
    record(deps, `Register this server's address: ${registration.domain}`, actorEmail);
    return getAddressState(deps);
  });
}

/** Stored as a decision, so that running `setup` again doesn't sign the server back up. */
export async function releaseAddress(
  deps: AppDeps,
  confirm: string,
  actorEmail: string | undefined,
): Promise<OpsifierAddressState> {
  return exclusive(deps, async () => {
    const current = readAddress(deps.db);
    if (current?.status !== "registered") {
      throw conflict("address_not_registered", "This server has no address to release.");
    }
    if (confirm !== current.domain) {
      throw conflict("confirmation_mismatch", "Type the address to confirm.", {
        confirm: "Does not match the address",
      });
    }
    await tellServiceReleased(deps, current);
    await removeAddressSecret(traefikDir(deps));
    saveAddress(deps.db, { status: "off", at: new Date(deps.now()).toISOString() }, new Date(deps.now()));

    const fallback = generatedServiceBase(deps);
    if (fallback !== null) {
      await moveHosts(deps, current.domain, fallback);
    }
    await refreshRoutes(deps);
    await restartProxyIfBehind(deps, actorEmail);
    record(deps, `Release this server's address: ${current.domain}`, actorEmail);
    return getAddressState(deps);
  });
}

/** Sends a heartbeat when one is due. Returns whether it tried. */
export async function sendDueHeartbeat(deps: AppDeps, minimumGapMs: number = DAY_MS): Promise<boolean> {
  const { namesUrl } = deps.config;
  const address = readAddress(deps.db);
  if (namesUrl === null || address?.status !== "registered") {
    return false;
  }
  // Both of these need a person: asking again every day would change nothing.
  if (address.health === "lost" || address.health === "disabled") {
    return false;
  }
  const last = address.lastHeartbeatAt === null ? 0 : Date.parse(address.lastHeartbeatAt);
  if (deps.now() - last < minimumGapMs) {
    return false;
  }

  const credentials = credentialsOf(deps, address);
  if (credentials === null) {
    return false;
  }
  const finish = (changes: Partial<RegisteredAddress>) => {
    // Someone may have released or replaced the address while this was on the wire.
    const current = readAddress(deps.db);
    if (current?.status === "registered" && current.id === address.id) {
      saveAddress(deps.db, { ...current, ...changes }, new Date(deps.now()));
    }
  };
  try {
    const { ip } = await sendHeartbeat(namesUrl, credentials);
    finish({ ip, health: "ok", lastHeartbeatAt: new Date(deps.now()).toISOString() });
  } catch (error) {
    const health =
      error instanceof NamesServiceError && error.kind === "denied"
        ? "lost"
        : error instanceof NamesServiceError && error.kind === "gone"
          ? "disabled"
          : "unreachable";
    deps.logger.warn({ err: error, health }, "The address service did not take this server's heartbeat");
    finish({ health });
  }
  return true;
}

/**
 * Puts back Traefik's secret file if it is missing, and restarts the proxy if a change didn't reach it.
 * Nothing here may stop the panel from starting: at worst, a certificate waits for the next restart.
 */
export async function reconcileAddress(deps: AppDeps): Promise<void> {
  try {
    const address = readAddress(deps.db);
    if (address?.status === "registered") {
      const present = await readFile(addressSecretPath(traefikDir(deps)), "utf8").catch(() => null);
      const credentials = present === null ? credentialsOf(deps, address) : null;
      if (credentials !== null) {
        await writeAddressSecret(traefikDir(deps), credentials.secret);
      }
    }
    await restartProxyIfBehind(deps, undefined);
  } catch (error) {
    deps.logger.warn({ err: error }, "Could not bring the proxy's address configuration up to date");
  }
}
