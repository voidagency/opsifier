/** Shared by every form that shows how full something is: `Gauge`, `GaugeBar` and `Sparkline`. */

/** Fractions of the maximum at which a reading turns busy and then bad. */
export interface Thresholds {
  busy: number;
  bad: number;
}

export const defaultThresholds: Thresholds = { busy: 0.7, bad: 0.9 };

export type Level = "ok" | "busy" | "bad";

export const levelColor: Record<Level, string> = {
  ok: "var(--state-running)",
  busy: "var(--state-progress)",
  bad: "var(--state-failed)",
};

export interface Reading {
  /** The value clamped to 0..max, for the `aria-valuenow` of a meter. */
  value: number;
  fraction: number;
  level: Level;
  /** The fraction as a whole percentage, the default centre value. */
  percent: string;
}

function isReadable(value: number | null | undefined, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isFinite(max) && max > 0;
}

export function levelOf(fraction: number, thresholds: Thresholds): Level {
  if (fraction >= thresholds.bad) {
    return "bad";
  }
  return fraction >= thresholds.busy ? "busy" : "ok";
}

/** Null when there is nothing to show: no value, an unusable one, or no maximum to measure it against. */
export function readQuantity(
  value: number | null | undefined,
  max: number,
  thresholds: Thresholds,
): Reading | null {
  if (!isReadable(value, max)) {
    return null;
  }
  const clamped = Math.min(Math.max(value, 0), max);
  const fraction = clamped / max;
  return {
    value: clamped,
    fraction,
    level: levelOf(fraction, thresholds),
    percent: `${Math.round(fraction * 100)}%`,
  };
}
