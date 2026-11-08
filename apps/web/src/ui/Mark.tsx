import { cn } from "../lib/cn";

/** The Opsifier mark: a ring with one amber tick, drawn to hold up at 20px. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-5 shrink-0", className)} fill="none">
      <circle cx="16" cy="16" r="11.9" stroke="var(--ink)" strokeWidth="5" />
      <path d="M14.1 4.25A11.9 11.9 0 0 1 17.9 4.25" stroke="var(--highlight)" strokeWidth="5" />
    </svg>
  );
}
