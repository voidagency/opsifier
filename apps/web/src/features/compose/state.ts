import type { ComposeChildState } from "@opsifier/contract";
import type { VisualState } from "../../ui";

/** How a child's state reads in the one state language of the interface. */
export const childVisualState: Record<ComposeChildState, VisualState> = {
  failed: "failed",
  unhealthy: "degraded",
  starting: "progress",
  running: "running",
  stopped: "stopped",
  completed: "stopped",
};
