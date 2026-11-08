import { cn } from "../lib/cn";

/** A placeholder block. Size it with className. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("block h-4 animate-pulse rounded-sm bg-wash", className)} />;
}
