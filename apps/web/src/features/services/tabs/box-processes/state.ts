import type { BoxProcessState } from "@opsifier/contract";
import type { VisualState } from "../../../../ui";

/** A process that keeps exiting and coming back is the one thing here that someone should look at. */
export function processVisualState(state: BoxProcessState): VisualState {
  const states: Record<BoxProcessState, VisualState> = {
    running: "running",
    restarting: "degraded",
    stopped: "stopped",
    disabled: "stopped",
    unknown: "unknown",
  };
  return states[state];
}
