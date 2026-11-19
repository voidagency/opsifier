import { eq } from "drizzle-orm";
import type { AppDeps } from "../../core/context";
import type { DbHandle } from "../../core/db";
import { settings } from "../../core/db/schema";
import { conflict } from "../../core/errors";
import { sslipBase } from "../../core/proxy/sslip";
import { liveAddressDomain, readAddress } from "../opsifier-address/repo";
import { routesOverlap } from "../service-tabs/domains/repo";
import { getSystemInfo } from "../system/service";

export const PANEL_DOMAIN_KEY = "panel_domain";

export interface PanelDomain {
  customDomain: string | null;
  serveOnIp: boolean;
}

export function readPanelDomain(db: DbHandle): PanelDomain {
  const value = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, PANEL_DOMAIN_KEY))
    .get()?.value as Partial<PanelDomain> | undefined;
  return {
    customDomain: typeof value?.customDomain === "string" ? value.customDomain : null,
    serveOnIp: value?.serveOnIp !== false,
  };
}

/**
 * The panel's name on sslip.io. It keeps answering once the server has an address too: a request can be
 * approved while nobody is looking, and that must not take away the name people have been using.
 */
export function sslipPanelDomain(deps: Pick<AppDeps, "db" | "config">): string | null {
  const { serverIp } = getSystemInfo(deps as AppDeps);
  return serverIp === null ? null : `panel.${sslipBase(serverIp)}`;
}

/** The generated hostname the panel is known by: under its address, or `panel.<server-ip>.sslip.io`. */
export function defaultPanelDomain(deps: Pick<AppDeps, "db" | "config">): string | null {
  const address = liveAddressDomain(deps.db);
  return address === null ? sslipPanelDomain(deps) : `panel.${address}`;
}

function stripPort(host: string): string {
  return host.startsWith("[") ? host.slice(1, host.indexOf("]")) : (host.split(":", 1)[0] ?? "");
}

/** With `serveOnIp` off, only requests that name the panel's own domains get an answer. */
export function isPanelHostAllowed(
  deps: Pick<AppDeps, "db" | "config">,
  hostHeader: string | undefined,
): boolean {
  const domain = readPanelDomain(deps.db);
  if (domain.serveOnIp) {
    return true;
  }
  const host = stripPort(hostHeader?.trim().toLowerCase() ?? "");
  return (
    host === domain.customDomain ||
    host === defaultPanelDomain(deps) ||
    host === sslipPanelDomain(deps) ||
    host === "localhost" ||
    host === ""
  );
}

/**
 * Whether a request reached the panel under one of its own names: not under an address, nor under a
 * name that only reaches it because it is served on its IP.
 */
export function isPanelOwnName(
  deps: Pick<AppDeps, "db" | "config">,
  hostHeader: string | undefined,
): boolean {
  const host = stripPort(hostHeader?.trim().toLowerCase() ?? "");
  if (host === "") {
    return false;
  }
  const names = [readPanelDomain(deps.db).customDomain, defaultPanelDomain(deps), sslipPanelDomain(deps)];
  return names.some((name) => name !== null && name !== "" && name === host);
}

/**
 * The names the panel answers on, or will: its own, the proxy dashboard's, and those of an address the
 * server asked for and may get at any time, approved while nobody looks. A name taken by a service
 * first would otherwise be the panel's later.
 */
function panelNames(deps: Pick<AppDeps, "db" | "config">): string[] {
  const { serverIp } = getSystemInfo(deps as AppDeps);
  const sslip = serverIp === null ? null : sslipBase(serverIp);
  const address = readAddress(deps.db);
  const asked = address !== null && "domain" in address ? address.domain : null;
  return [
    readPanelDomain(deps.db).customDomain,
    defaultPanelDomain(deps),
    sslipPanelDomain(deps),
    sslip === null ? null : `proxy.${sslip}`,
    asked === null ? null : `panel.${asked}`,
    asked === null ? null : `proxy.${asked}`,
    asked,
  ].filter((name): name is string => name !== null && name !== "");
}

/** Whether a name, or a wildcard over it, is one the panel answers on or will. */
export function isReservedForPanel(
  deps: Pick<AppDeps, "db" | "config">,
  host: string,
  wildcard: boolean,
): boolean {
  const claim = { host, path: "/", wildcard };
  return panelNames(deps).some((name) => routesOverlap(claim, { host: name, path: "/", wildcard: false }));
}

/** The panel's own names, and any wildcard that would cover them, can't be given to a service. */
export function assertHostAvailableForPanel(
  deps: Pick<AppDeps, "db" | "config">,
  host: string,
  wildcard: boolean,
): void {
  if (isReservedForPanel(deps, host, wildcard)) {
    throw conflict("domain_reserved", "This hostname belongs to the panel.", {
      host: "Reserved for the panel",
    });
  }
}
