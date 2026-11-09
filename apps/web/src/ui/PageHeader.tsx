import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Sits to the left of the title and description: where a large lamp goes. */
  leading?: ReactNode;
  /** Sits under the title, flush with the rule: where underlined tabs go. */
  children?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, leading, children, className }: PageHeaderProps) {
  return (
    <header className={cn("border-b px-4 pt-6 md:px-6 lg:px-8", !children && "pb-5", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className={cn("min-w-0", leading !== undefined && "flex items-start gap-3.5")}>
          {leading}
          <div className="min-w-0">
            <h1 className="text-xl font-medium tracking-[-0.01em]">{title}</h1>
            {description && <div className="mt-1 max-w-[64ch] text-muted">{description}</div>}
          </div>
        </div>
        {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </header>
  );
}
