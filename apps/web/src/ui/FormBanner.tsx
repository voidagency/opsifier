import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export type BannerTone = "error" | "warning" | "success" | "info";

const tones = {
  error: { icon: CircleAlert, edge: "before:bg-bad", mark: "text-bad" },
  warning: { icon: TriangleAlert, edge: "before:bg-busy", mark: "text-busy" },
  success: { icon: CircleCheck, edge: "before:bg-ok", mark: "text-ok" },
  info: { icon: Info, edge: "before:bg-off", mark: "text-off" },
} as const;

export interface FormBannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** A message that belongs to a whole form or section. Field problems go on the fields. */
export function FormBanner({ tone = "error", title, children, className }: FormBannerProps) {
  const { icon: Icon, edge, mark } = tones[tone];
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      aria-live={tone === "error" ? undefined : "polite"}
      className={cn(
        "relative flex gap-2.5 overflow-hidden rounded-sm bg-wash py-2.5 pr-3 pl-3.5 text-sm before:absolute before:inset-y-0 before:left-0 before:w-0.5",
        edge,
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", mark)} />
      <div className="min-w-0">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(Boolean(title) && "mt-0.5 text-muted")}>{children}</div>}
      </div>
    </div>
  );
}
