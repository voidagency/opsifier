import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface EmptyStateProps {
  /** A chart fragment from `ChartFigures`, shown in a ruled inset above the text. */
  figure?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ figure, title, description, action, className }: EmptyStateProps) {
  return (
    <section className={cn("grid gap-5", className)}>
      {figure && (
        <div
          aria-hidden="true"
          className="h-[180px] overflow-hidden rounded-sm border bg-raised md:h-[220px]"
        >
          {figure}
        </div>
      )}
      <div>
        <h2 className="text-md font-medium">{title}</h2>
        {description && <p className="mt-1 max-w-[60ch] text-muted">{description}</p>}
        {action && <div className="mt-4 flex flex-wrap gap-2">{action}</div>}
      </div>
    </section>
  );
}
