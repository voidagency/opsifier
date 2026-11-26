import { useSyncExternalStore } from "react";

/** The guided tours, each a series of steps that point at one part of the screen at a time. */
export type TourId = "panel" | "service";
export type TourEnd = "done" | "dismissed";

/**
 * Whether the Get started guide shows on the Overview: on its own while nothing is deployed, never once
 * hidden, and always once asked for again from the account menu, until hidden.
 */
export type GuideMode = "auto" | "hidden" | "shown";

export interface Progress {
  tours: Partial<Record<TourId, TourEnd>>;
  guide: GuideMode;
}

const EMPTY: Progress = { tours: {}, guide: "auto" };
const keyOf = (userId: string) => `opsifier.onboarding.${userId}`;
const TOURS: readonly TourId[] = ["panel", "service"];
const ENDS: readonly TourEnd[] = ["done", "dismissed"];
const GUIDES: readonly GuideMode[] = ["auto", "hidden", "shown"];

const cache = new Map<string, Progress>();
const listeners = new Set<() => void>();

/** What this browser remembers for an account. Anything it can't read counts as never seen. */
function read(userId: string): Progress {
  const cached = cache.get(userId);
  if (cached !== undefined) {
    return cached;
  }
  let progress = EMPTY;
  try {
    const stored = JSON.parse(localStorage.getItem(keyOf(userId)) ?? "null") as unknown;
    if (typeof stored === "object" && stored !== null) {
      const { tours, guide } = stored as { tours?: Record<string, unknown>; guide?: unknown };
      progress = {
        tours: Object.fromEntries(
          TOURS.flatMap((tour) => {
            const end = tours?.[tour];
            return ENDS.includes(end as TourEnd) ? [[tour, end as TourEnd]] : [];
          }),
        ),
        guide: GUIDES.includes(guide as GuideMode) ? (guide as GuideMode) : "auto",
      };
    }
  } catch {
    // Storage can be blocked, or hold something else: the guide and the tours simply show again.
  }
  cache.set(userId, progress);
  return progress;
}

function write(userId: string, next: Progress): void {
  cache.set(userId, next);
  try {
    localStorage.setItem(keyOf(userId), JSON.stringify(next));
  } catch {
    // Kept until the page is reloaded.
  }
  for (const listener of listeners) {
    listener();
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useProgress(userId: string | null): Progress {
  return useSyncExternalStore(subscribe, () => (userId === null ? EMPTY : read(userId)));
}

export function markTour(userId: string, tour: TourId, end: TourEnd): void {
  const progress = read(userId);
  write(userId, { ...progress, tours: { ...progress.tours, [tour]: end } });
}

export function setGuide(userId: string, guide: GuideMode): void {
  write(userId, { ...read(userId), guide });
}

/** Forgets what the tests did, between two of them. */
export function resetProgressCache(): void {
  cache.clear();
}
