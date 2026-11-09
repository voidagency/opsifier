import { type MetricsRange, type MetricsStep, metricsRanges, metricsSteps } from "@opsifier/contract";
import { useCallback, useSyncExternalStore } from "react";

export const refreshChoices = ["off", "1s", "5s", "10s", "30s", "1m"] as const;
export type RefreshChoice = (typeof refreshChoices)[number];

const refreshMs: Record<RefreshChoice, number | false> = {
  off: false,
  "1s": 1000,
  "5s": 5000,
  "10s": 10_000,
  "30s": 30_000,
  "1m": 60_000,
};

export const refreshInterval = (choice: RefreshChoice) => refreshMs[choice];

export interface MetricsPreferences {
  refresh: RefreshChoice;
  range: MetricsRange;
  step: MetricsStep;
}

const STORAGE_KEY = "opsifier.metrics";
const DEFAULTS: MetricsPreferences = { refresh: "5s", range: "24h", step: "5m" };

function read(): MetricsPreferences {
  try {
    const stored = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "null",
    ) as Partial<MetricsPreferences> | null;
    return {
      refresh: refreshChoices.includes(stored?.refresh as RefreshChoice)
        ? (stored?.refresh as RefreshChoice)
        : DEFAULTS.refresh,
      range: metricsRanges.includes(stored?.range as MetricsRange)
        ? (stored?.range as MetricsRange)
        : DEFAULTS.range,
      step: metricsSteps.includes(stored?.step as MetricsStep)
        ? (stored?.step as MetricsStep)
        : DEFAULTS.step,
    };
  } catch {
    return DEFAULTS;
  }
}

let current = read();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** How the charts refresh and what they cover. Chosen per browser and kept across reloads. */
export function useMetricsPreferences(): [
  MetricsPreferences,
  (changes: Partial<MetricsPreferences>) => void,
] {
  const preferences = useSyncExternalStore(subscribe, () => current);
  const update = useCallback((changes: Partial<MetricsPreferences>) => {
    current = { ...current, ...changes };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch {
      // The choice still applies until the next reload.
    }
    for (const listener of listeners) {
      listener();
    }
  }, []);
  return [preferences, update];
}
