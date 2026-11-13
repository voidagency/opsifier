import { eq } from "drizzle-orm";
import type { AppDeps } from "../../core/context";
import type { DbHandle } from "../../core/db";
import { settings } from "../../core/db/schema";
import { conflict } from "../../core/errors";
import { liveAddressDomain } from "../opsifier-address/repo";
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
  return serverIp === null ? null : `panel.${serverIp.replaceAll(":", "-")}.sslip.io`;
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

/** The panel's own names, and any wildcard that would cover them, can't be given to a service. */
export function assertHostAvailableForPanel(
  deps: Pick<AppDeps, "db" | "config">,
  host: string,
  wildcard: boolean,
): void {
  const reserved = [
    readPanelDomain(deps.db).customDomain,
    defaultPanelDomain(deps),
    sslipPanelDomain(deps),
  ].filter((name): name is string => name !== null);
  const claim = { host, path: "/", wildcard };
  if (reserved.some((name) => routesOverlap(claim, { host: name, path: "/", wildcard: false }))) {
    throw conflict("domain_reserved", "This hostname belongs to the panel.", {
      host: "Reserved for the panel",
    });
  }
}
