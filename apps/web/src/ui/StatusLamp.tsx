import { cn } from "../lib/cn";

export type LampStatus = "ok" | "busy" | "off" | "bad";

const glyphs: Record<LampStatus, React.JSX.Element> = {
  ok: <circle cx="6" cy="6" r="4" fill="var(--ok)" />,
  busy: (
    <>
      <circle cx="6" cy="6" r="3.4" fill="none" stroke="var(--busy)" strokeWidth="1.2" />
      <path d="M6 2.6a3.4 3.4 0 0 1 0 6.8z" fill="var(--busy)" />
    </>
  ),
  off: <circle cx="6" cy="6" r="3.4" fill="none" stroke="var(--off)" strokeWidth="1.2" />,
  bad: (
    <rect x="2.75" y="2.75" width="6.5" height="6.5" rx="0.8" transform="rotate(45 6 6)" fill="var(--bad)" />
  ),
};

export interface StatusLampProps {
  status: LampStatus;
  /** What the lamp means, in words. Announced to assistive technology and shown when `showLabel` is on. */
  label: string;
  showLabel?: boolean;
  className?: string;
}

/** Each state has its own shape as well as its own colour, so it reads without colour vision. */
export function StatusLamp({ status, label, showLabel = false, className }: StatusLampProps) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className="relative inline-flex size-3 shrink-0">
        {status === "busy" && (
          <span aria-hidden="true" className="absolute inset-0 animate-lamp rounded-full bg-busy" />
        )}
        <svg
          viewBox="0 0 12 12"
          className="relative size-3"
          role="img"
          aria-label={showLabel ? undefined : label}
          aria-hidden={showLabel || undefined}
        >
          {glyphs[status]}
        </svg>
      </span>
      {showLabel && <span className="text-xs">{label}</span>}
    </span>
  );
}
