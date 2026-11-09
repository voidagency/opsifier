import type { ActionStatus, DeployOutcome, ScriptRunStatus, ServiceStatus } from "@opsifier/contract";
import type { LampStatus } from "../StatusLamp";

/**
 * The one state language of the interface. Every lamp, count and summary draws from this table,
 * so a state always has the same colour, shape, label and motion wherever it appears.
 * Colours are declared in theme.css. Labels are in strings.ts.
 */

/** Every state, in reading order: problems first, quiet things last. Lists and counts follow this order. */
export const visualStates = ["failed", "degraded", "unknown", "progress", "running", "stopped"] as const;
export type VisualState = (typeof visualStates)[number];

/** Each state has its own silhouette, so it reads without colour. */
export type StateShape = "diamond" | "triangle" | "broken-ring" | "turning-ring" | "disc" | "ring";

/**
 * `turn` runs for as long as the work does. `breathe` and `alarm` play three times when a problem
 * appears, then hold still. Calm states never move. All of it stops under prefers-reduced-motion,
 * and a still lamp is complete: the shape carries the state.
 */
export type StateMotion = "none" | "turn" | "breathe" | "alarm";

export interface StateDefinition {
  color: `var(--state-${VisualState})`;
  shape: StateShape;
  motion: StateMotion;
  /** Short label, in the `visual` namespace. */
  labelKey: `state.${VisualState}`;
  /** Someone should look at this. Decides what a summary counts as a problem. */
  problem: boolean;
}

export const stateLanguage: Record<VisualState, StateDefinition> = {
  failed: {
    color: "var(--state-failed)",
    shape: "diamond",
    motion: "alarm",
    labelKey: "state.failed",
    problem: true,
  },
  degraded: {
    color: "var(--state-degraded)",
    shape: "triangle",
    motion: "breathe",
    labelKey: "state.degraded",
    problem: true,
  },
  unknown: {
    color: "var(--state-unknown)",
    shape: "broken-ring",
    motion: "none",
    labelKey: "state.unknown",
    problem: true,
  },
  progress: {
    color: "var(--state-progress)",
    shape: "turning-ring",
    motion: "turn",
    labelKey: "state.progress",
    problem: false,
  },
  running: {
    color: "var(--state-running)",
    shape: "disc",
    motion: "none",
    labelKey: "state.running",
    problem: false,
  },
  stopped: {
    color: "var(--state-stopped)",
    shape: "ring",
    motion: "none",
    labelKey: "state.stopped",
    problem: false,
  },
};

/** The existing `StatusLamp` statuses, for code moving to `Lamp`. */
export function stateFromLamp(status: LampStatus): VisualState {
  const states: Record<LampStatus, VisualState> = {
    ok: "running",
    busy: "progress",
    off: "stopped",
    bad: "failed",
  };
  return states[status];
}

export interface ServiceStateInput {
  status: ServiceStatus;
  activeAction?: unknown;
  replicas?: { running: number; desired: number };
  /** Set while nobody can say what the service is really running. */
  runtimeUncertain?: unknown;
}

/**
 * Work in progress wins over what is running, because that is what is happening.
 * A failing service that still has tasks up is degraded, not down.
 */
export function stateFromService({
  status,
  activeAction,
  replicas,
  runtimeUncertain,
}: ServiceStateInput): VisualState {
  if (activeAction !== undefined && activeAction !== null) {
    return "progress";
  }
  if (runtimeUncertain !== undefined && runtimeUncertain !== null) {
    return "unknown";
  }
  const states: Record<ServiceStatus, VisualState> = {
    running: "running",
    starting: "progress",
    failing: (replicas?.running ?? 0) > 0 ? "degraded" : "failed",
    stopped: "stopped",
    undeployed: "stopped",
    unknown: "unknown",
  };
  return states[status];
}

/** A finished success wears the running state's lamp: pass it a label such as "Succeeded". */
export function stateFromAction(status: ActionStatus): VisualState {
  const states: Record<ActionStatus, VisualState> = {
    queued: "progress",
    running: "progress",
    succeeded: "running",
    failed: "failed",
    cancelled: "stopped",
    // The panel does not know how it ended, and someone should go and look.
    uncertain: "unknown",
  };
  return states[status];
}

export function stateFromOutcome(outcome: DeployOutcome): VisualState {
  return stateFromAction(outcome);
}

/** A run with no known ending reads as unknown, never as a failure it might not have been. */
export function stateFromScriptRun(status: ScriptRunStatus): VisualState {
  const states: Record<ScriptRunStatus, VisualState> = {
    queued: "progress",
    running: "progress",
    succeeded: "running",
    failed: "failed",
    timed_out: "failed",
    cancelled: "stopped",
    skipped: "stopped",
    unknown: "unknown",
  };
  return states[status];
}

export type HealthCounts = Partial<Record<VisualState, number>>;

export function countStates(states: Iterable<VisualState>): HealthCounts {
  const counts: HealthCounts = {};
  for (const state of states) {
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return counts;
}

export function problemCount(counts: HealthCounts): number {
  return visualStates.reduce(
    (total, state) => total + (stateLanguage[state].problem ? (counts[state] ?? 0) : 0),
    0,
  );
}

/** The state of a whole: the first state in reading order that anything is in. */
export function overallState(counts: HealthCounts): VisualState | null {
  return visualStates.find((state) => (counts[state] ?? 0) > 0) ?? null;
}
