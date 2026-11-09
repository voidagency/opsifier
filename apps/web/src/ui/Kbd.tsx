import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** A keyboard key, as shown in hints. */
export function Kbd({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[24px] min-w-[24px] items-center justify-center rounded-sm border px-1 font-mono text-micro text-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
