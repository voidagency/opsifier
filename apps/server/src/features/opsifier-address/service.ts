import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  OpsifierAddressState,
  OpsifierAddressStatus,
  RequestOpsifierAddressRequest,
} from "@opsifier/contract";
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
  type RequestAnswer,
  releaseServer,
  requestServerAddress,
  sendHeartbeat,
} from "./client";
import { addressSecretPath, removeAddressSecret, writeAddressSecret } from "./proxy-env";
import {
  ADDRESS_SECRET_CONTEXT,
  type RegisteredAddress,
  type RequestedAddress,
  readAddress,
  saveAddress,
} from "./repo";

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
    const waiting = address?.status === "requested" ? address : null;
    return {
      status: waiting?.status ?? (address?.status === "refused" ? "refused" : "off"),
      available,
      domain: waiting?.domain ?? null,
      wildcard: null,
      certificate: null,
      panelUrl: panel === null ? null : `https://${panel}`,
      ip: null,
      registeredAt: null,
      requestedAt: waiting?.requestedAt ?? null,
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
    requestedAt: null,
    lastHeartbeatAt: address.lastHeartbeatAt,
  };
}

/** One change to the address at a time, so that two can't finish out of order. */
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

type Held = Pick<RegisteredAddress | RequestedAddress, "id" | "sealedSecret">;

function credentialsOf(deps: AppDeps, address: Held): Credentials | null {
  try {
    return { id: address.id, secret: deps.secrets.unseal(address.sealedSecret, ADDRESS_SECRET_CONTEXT) };
  } catch {
    deps.logger.warn("The address secret could not be read");
    return null;
  }
}

/** Telling the service is a courtesy: what happens here doesn't depend on it being reachable. */
async function tellServiceReleased(deps: AppDeps, address: Held): Promise<void> {
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

function storedRequest(deps: AppDeps, answer: RequestAnswer): RequestedAddress {
  return {
    status: "requested",
    id: answer.id,
    domain: answer.domain,
    sealedSecret: deps.secrets.seal(answer.secret, ADDRESS_SECRET_CONTEXT),
    requestedAt: new Date(deps.now()).toISOString(),
  };
}

/**
 * Asks for an address. Nothing changes on this server until the answer comes: the check that follows
 * finds out, and an address that is approved is taken up with nobody having to be here.
 */
export async function requestAddress(
  deps: AppDeps,
  request: RequestOpsifierAddressRequest,
  actorEmail: string | undefined,
): Promise<OpsifierAddressState> {
  return exclusive(deps, async () => {
    const { namesUrl } = deps.config;
    if (namesUrl === null) {
      throw conflict("address_service_off", "This server is set to never call the address service.");
    }
    const current = readAddress(deps.db);
    if (current?.status === "requested") {
      throw conflict("address_request_waiting", "A request is already waiting for an answer.");
    }
    if (current?.status === "registered") {
      throw conflict(
        "address_already_registered",
        "Release this server's address before asking for another.",
      );
    }
    let answer: RequestAnswer;
    try {
      answer = await requestServerAddress(namesUrl, request);
    } catch (error) {
      throw serviceError(error);
    }
    saveAddress(deps.db, storedRequest(deps, answer), new Date(deps.now()));
    record(deps, `Ask for an address for this server: ${answer.domain}`, actorEmail);
    return getAddressState(deps);
  });
}

/** Withdraws a request that is still waiting. Telling the service is a courtesy here too. */
export async function cancelAddressRequest(
  deps: AppDeps,
  actorEmail: string | undefined,
): Promise<OpsifierAddressState> {
  return exclusive(deps, async () => {
    const current = readAddress(deps.db);
    if (current?.status !== "requested") {
      throw conflict("address_no_request", "This server has no request waiting.");
    }
    await tellServiceReleased(deps, current);
    saveAddress(deps.db, { status: "off", at: new Date(deps.now()).toISOString() }, new Date(deps.now()));
    record(deps, `Withdraw the request for an address: ${current.domain}`, actorEmail);
    return getAddressState(deps);
  });
}

/**
 * The answer was yes, so the server becomes what it asked to be. Names generated so far move with it, as
 * they move back when the address is released.
 */
async function takeUpAddress(deps: AppDeps, request: RequestedAddress, ip: string): Promise<void> {
  const credentials = credentialsOf(deps, request);
  if (credentials === null) {
    return;
  }
  const base = generatedServiceBase(deps);
  const now = new Date(deps.now());
  await writeAddressSecret(traefikDir(deps), credentials.secret);
  saveAddress(
    deps.db,
    {
      status: "registered",
      id: request.id,
      domain: request.domain,
      sealedSecret: request.sealedSecret,
      ip,
      registeredAt: now.toISOString(),
      // The first heartbeat comes a day after this answer, which was as good as one.
      lastHeartbeatAt: now.toISOString(),
      health: "ok",
    },
    now,
  );
  if (base !== null) {
    await moveHosts(deps, base, request.domain);
  }
  await refreshRoutes(deps);
  await restartProxyIfBehind(deps, undefined);
  record(deps, `This server's address was approved: ${request.domain}`, undefined);
}

/** Finds out whether a request has been answered, and acts on it. Returns whether it asked. */
export async function checkAddressRequest(deps: AppDeps): Promise<boolean> {
  const { namesUrl } = deps.config;
  const request = readAddress(deps.db);
  // Someone changing the address right now decides what happens to it. The next check comes soon enough.
  if (namesUrl === null || request?.status !== "requested" || inProgress.has(deps)) {
    return false;
  }
  const credentials = credentialsOf(deps, request);
  if (credentials === null) {
    return false;
  }
  await exclusive(deps, async () => {
    try {
      const { ip, status } = await sendHeartbeat(namesUrl, credentials);
      if (status === "active") {
        await takeUpAddress(deps, request, ip);
      }
    } catch (error) {
      const at = new Date(deps.now()).toISOString();
      if (error instanceof NamesServiceError && error.kind === "declined") {
        saveAddress(deps.db, { status: "refused", at }, new Date(deps.now()));
        record(deps, `The request for an address was refused: ${request.domain}`, undefined);
      } else if (error instanceof NamesServiceError && error.kind === "denied") {
        // Nobody answered in time, and the service has let the request go.
        saveAddress(deps.db, { status: "off", at }, new Date(deps.now()));
      } else {
        deps.logger.warn({ err: error }, "Could not find out whether the address request was answered");
      }
    }
  });
  return true;
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
