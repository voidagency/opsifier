import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { systemInfoQuery } from "../../app/shell/systemInfo";
import { useCurrentUser } from "../auth/session";
import { purposeQuery } from "../server-purpose/api";
import { serviceDomainQuery } from "../settings/server/api";
import { useStudioOnly } from "../studio/studioOnly";
import { sslipBase } from "./address";
import { baseOf } from "./GetStarted";
import { markTour, type TourId, useProgress } from "./progress";
import { Tour } from "./Tour";
import { endTour, SERVICE_PAGE, startTour, tours, useActiveTour } from "./tours";

const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform);
/** How long the screen has to be settled before a tour offers itself. */
const SETTLE_MS = 900;

/** Whether a dialog, a menu or a toast asks for attention: a tour never starts over one. */
function somethingOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null;
}

/** Starts a tour once the screen has settled and nothing else is open, unless the page changes first. */
function useOfferOnce(tour: TourId, when: boolean) {
  useEffect(() => {
    if (!when) {
      return;
    }
    let waited = 0;
    const check = window.setInterval(() => {
      waited = somethingOpen() ? 0 : waited + 300;
      if (waited >= SETTLE_MS) {
        window.clearInterval(check);
        startTour(tour);
      }
    }, 300);
    return () => window.clearInterval(check);
  }, [tour, when]);
}

/**
 * Shows the tour under way, over every screen, and offers each one once: the panel's on the Overview
 * once the server's purpose is chosen, to an administrator; a service's the first time one opens.
 */
export function TourHost() {
  const user = useCurrentUser();
  const studioOnly = useStudioOnly();
  const active = useActiveTour();
  const progress = useProgress(user?.id ?? null);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const admin = user?.role === "admin";
  const panelUi = user !== null && studioOnly === false;
  const purpose = useQuery({ ...purposeQuery, enabled: panelUi && admin });
  const system = useQuery({ ...systemInfoQuery, enabled: panelUi });
  const domains = useQuery({ ...serviceDomainQuery, enabled: panelUi && admin });

  useOfferOnce(
    "panel",
    panelUi &&
      admin &&
      active === null &&
      pathname === "/" &&
      progress.tours.panel === undefined &&
      purpose.data !== undefined &&
      purpose.data.purpose !== null,
  );
  useOfferOnce(
    "service",
    panelUi &&
      active === null &&
      SERVICE_PAGE.test(pathname) &&
      // After the panel's own tour for an administrator, who is offered that one first.
      (progress.tours.panel !== undefined || !admin) &&
      progress.tours.service === undefined,
  );

  // A tour belongs to the screen it started on: going elsewhere ends it, as Escape would, and it counts
  // as left, so it does not offer itself again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of screen ends it
  useEffect(() => {
    if (active !== null) {
      if (user !== null) {
        markTour(user.id, active, "dismissed");
      }
      endTour();
    }
  }, [pathname]);

  if (active === null || user === null) {
    return null;
  }

  const serverIp = system.data?.serverIp ?? null;
  const base =
    baseOf(domains.data?.customDomain ?? domains.data?.defaultDomain ?? null) ??
    (serverIp === null ? "sslip.io" : sslipBase(serverIp));

  return (
    <Tour
      key={active}
      tour={active}
      steps={tours[active]}
      values={{ base, shortcut: isMac ? "⌘K" : "Ctrl K" }}
      onEnd={(end) => {
        // A tour with nothing to show on this screen was not seen: it can offer itself elsewhere.
        if (end !== null) {
          markTour(user.id, active, end);
        }
        endTour();
      }}
    />
  );
}
