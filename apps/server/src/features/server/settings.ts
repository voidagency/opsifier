import type { PanelDomainSettings, SavePanelDomainRequest, ServiceDomainSettings } from "@opsifier/contract";
import { letsEncryptEmail } from "@opsifier/contract";
import { asc, eq } from "drizzle-orm";
import type { z } from "zod";
import type { AppDeps } from "../../core/context";
import { users } from "../../core/db/schema";
import { conflict } from "../../core/errors";
import { isCoveredByWildcard } from "../opsifier-address/certificates";
import { liveAddressDomain, registeredDomain } from "../opsifier-address/repo";
import { overlappingRoutes } from "../service-tabs/domains/repo";
import { getSetting, putSetting, SERVICE_DOMAIN_KEY } from "../system/repo";
import { getSystemInfo } from "../system/service";
import { defaultPanelDomain, PANEL_DOMAIN_KEY, readPanelDomain } from "./panel-host";

export const LETS_ENCRYPT_EMAIL_KEY = "letsencrypt_email";
export const DAILY_CLEANUP_KEY = "daily_docker_cleanup";
const SSLIP_SUFFIX = "sslip.io";

function sslipLabel(ip: string): string {
  return ip.includes(":") ? ip.toLowerCase().replaceAll(":", "-").replace(/^-/, "0-") : ip;
}

/** The server's address, or `<server-ip>.sslip.io`. Null while neither is known. */
export function generatedServiceBase(deps: AppDeps): string | null {
  const address = liveAddressDomain(deps.db);
  if (address !== null) {
    return address;
  }
  const { serverIp } = getSystemInfo(deps);
  return serverIp === null ? null : `${sslipLabel(serverIp)}.${SSLIP_SUFFIX}`;
}

export function getPanelDomainSettings(deps: AppDeps): PanelDomainSettings {
  const domain = readPanelDomain(deps.db);
  const defaultDomain = defaultPanelDomain(deps);
  const canonical = domain.customDomain ?? defaultDomain;
  return {
    defaultDomain,
    customDomain: domain.customDomain,
    serveOnIp: domain.serveOnIp,
    url: canonical === null ? null : `https://${canonical}`,
  };
}

/** Every hostname the proxy should send to the panel. */
export function panelHosts(deps: AppDeps): string[] {
  const domain = readPanelDomain(deps.db);
  const defaultDomain = defaultPanelDomain(deps);
  return [domain.customDomain, defaultDomain].filter((host): host is string => host !== null);
}

/**
 * A panel name under the address is served by the wildcard certificate, so it can't share a router with
 * one that needs a certificate of its own: Traefik would ask for a single certificate covering both.
 */
export async function writePanelRoutes(deps: AppDeps): Promise<void> {
  const hosts = panelHosts(deps);
  const address = registeredDomain(deps.db);
  const underAddress = (host: string) => address !== null && isCoveredByWildcard(host, address);
  await deps.proxy.writeBase({
    panelUpstream: deps.config.panelUpstream,
    panelHosts: hosts.filter((host) => !underAddress(host)),
    wildcardCertificateHosts: hosts.filter(underAddress),
  });
}

/** The other half of the panel's reservation: a name a route already answers on can't become the panel's. */
function assertNoRouteOn(deps: AppDeps, host: string): void {
  if (overlappingRoutes(deps.db, { host, path: "/", wildcard: false }).length > 0) {
    throw conflict("domain_taken", "A route already uses this hostname.", {
      customDomain: "A route already uses this hostname",
    });
  }
}

export async function savePanelDomain(
  deps: AppDeps,
  request: z.output<typeof import("@opsifier/contract").savePanelDomainRequest>,
  actorEmail: string | undefined,
): Promise<PanelDomainSettings> {
  const { customDomain } = request;
  if (customDomain !== null && customDomain !== readPanelDomain(deps.db).customDomain) {
    assertNoRouteOn(deps, customDomain);
  }
  putSetting(deps.db, PANEL_DOMAIN_KEY, request, new Date(deps.now()));
  await writePanelRoutes(deps);
  deps.actions.record({ type: "server.panel-domain", title: "Change the panel domain", actorEmail });
  return getPanelDomainSettings(deps);
}

export type PanelDomainInput = SavePanelDomainRequest;

export function getServiceDomainSettings(deps: AppDeps): ServiceDomainSettings {
  const custom = getSetting(deps.db, SERVICE_DOMAIN_KEY);
  const base = generatedServiceBase(deps);
  return {
    defaultDomain: base === null ? null : `*.${base}`,
    customDomain: typeof custom === "string" && custom !== "" ? custom : null,
  };
}

export function saveServiceDomain(
  deps: AppDeps,
  customDomain: string | null,
  actorEmail: string | undefined,
): ServiceDomainSettings {
  putSetting(deps.db, SERVICE_DOMAIN_KEY, customDomain ?? "", new Date(deps.now()));
  deps.actions.record({
    type: "server.service-domain",
    title: "Change the base domain for new services",
    actorEmail,
  });
  return getServiceDomainSettings(deps);
}

function ownerEmail(deps: AppDeps): string | null {
  return (
    deps.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.isOwner, true))
      .orderBy(asc(users.createdAt))
      .get()?.email ?? null
  );
}

export function getLetsEncryptEmail(deps: AppDeps): string | null {
  const stored = letsEncryptEmail.safeParse({ email: getSetting(deps.db, LETS_ENCRYPT_EMAIL_KEY) });
  return stored.success ? stored.data.email : ownerEmail(deps);
}

export function saveLetsEncryptEmail(deps: AppDeps, email: string, actorEmail: string | undefined): void {
  putSetting(deps.db, LETS_ENCRYPT_EMAIL_KEY, email, new Date(deps.now()));
  deps.actions.record({ type: "server.letsencrypt", title: "Change the Let's Encrypt email", actorEmail });
}

/** Off until someone turns it on: nothing removes Docker data on its own unless it was asked to. */
export function getDailyCleanup(deps: Pick<AppDeps, "db">): boolean {
  return getSetting(deps.db, DAILY_CLEANUP_KEY) === true;
}

export function saveDailyCleanup(deps: AppDeps, enabled: boolean, actorEmail: string | undefined): void {
  putSetting(deps.db, DAILY_CLEANUP_KEY, enabled, new Date(deps.now()));
  deps.actions.record({
    type: "server.daily-cleanup",
    title: `${enabled ? "Turn on" : "Turn off"} the daily Docker cleanup`,
    actorEmail,
  });
}
