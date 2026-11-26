import { useSyncExternalStore } from "react";
import type { TourId } from "./progress";

/**
 * One stop of a tour. `target` names the element it points at, by its `data-tour` attribute; a stop
 * without one is a card in the middle of the screen. Its words are `tours.<tour>.<id>` in `onboarding`.
 */
export interface TourStep {
  id: string;
  target?: string;
}

export const tours: Record<TourId, readonly TourStep[]> = {
  // The panel, from the Overview: where to start, then what is on every screen.
  panel: [
    { id: "welcome" },
    { id: "guide", target: "get-started" },
    { id: "project", target: "new-project" },
    { id: "domains", target: "nav-domains" },
    { id: "activity", target: "activity-tape" },
    { id: "purpose", target: "purpose" },
    { id: "palette", target: "palette" },
    { id: "account", target: "account" },
  ],
  // A service's page, the first time one opens.
  service: [
    { id: "state", target: "service-state" },
    { id: "deploy", target: "service-deploy" },
    { id: "open", target: "service-open" },
    { id: "logs", target: "service-logs" },
    { id: "tabs", target: "service-tabs" },
  ],
};

/** A service's own pages, where its tour can show: not the steps that set a new one up. */
export const SERVICE_PAGE = /^\/projects\/[^/]+\/app\/[^/]+(?:\/(?!init\/)[^/]*)?\/?$/;

let active: TourId | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Shows a tour from its first stop, replacing one already showing. */
export function startTour(tour: TourId): void {
  active = tour;
  emit();
}

export function endTour(): void {
  active = null;
  emit();
}

export function useActiveTour(): TourId | null {
  return useSyncExternalStore(subscribe, () => active);
}
