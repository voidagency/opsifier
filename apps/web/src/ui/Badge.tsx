import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export type BadgeTone = "neutral" | "ok" | "busy" | "off" | "bad" | "accent";

const marks: Record<BadgeTone, string> = {
  neutral: "bg-muted",
  ok: "bg-ok",
  busy: "bg-busy",
  off: "bg-off",
  bad: "bg-bad",
  accent: "bg-accent",
};

export interface BadgeProps {
  tone?: BadgeTone;
  /** IBM Plex Mono, for labels that are machine values such as an image tag. */
  mono?: boolean;
  className?: string;
  children: ReactNode;
}

/** The tone is carried by a small mark and the text stays in ink, so every tone passes contrast. */
export function Badge({ tone = "neutral", mono = false, className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-sm border px-1.5 text-xs whitespace-nowrap",
        mono && "font-mono",
        className,
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-[1px]", marks[tone])} />
      {children}
    </span>
  );
}
