import { cn } from "../lib/cn";

export type WakeOutcome = "succeeded" | "failed" | "running" | "cancelled";

const colors: Record<WakeOutcome, string> = {
  succeeded: "bg-ok",
  failed: "bg-bad",
  running: "bg-busy animate-pulse",
  cancelled: "bg-off",
};

export interface WakeStripProps {
  /** Deployment outcomes, oldest first. Only the most recent `capacity` are drawn. */
  outcomes: readonly WakeOutcome[];
  capacity?: number;
  /** A sentence summarising the strip for assistive technology. */
  label: string;
  className?: string;
}

/**
 * The last deployments as a row of small segments, read left to right like a ship's wake:
 * it narrows into the past, and failures stand at full height so they read without colour.
 */
export function WakeStrip({ outcomes, capacity = 24, label, className }: WakeStripProps) {
  const recent = outcomes.slice(-capacity);
  const missing = capacity - recent.length;

  return (
    <span role="img" aria-label={label} className={cn("inline-flex h-3.5 items-end gap-0.5", className)}>
      {Array.from({ length: capacity }, (_, index) => {
        const outcome = index < missing ? undefined : recent[index - missing];
        const height = outcome === "failed" ? 100 : 46 + (54 * index) / Math.max(capacity - 1, 1);
        return (
          <span
            // The position in the strip is the segment's identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length list that never reorders
            key={index}
            className={cn("block w-[5px] rounded-[1px]", outcome ? colors[outcome] : "bg-rule")}
            style={{ height: `${height}%` }}
          />
        );
      })}
    </span>
  );
}
