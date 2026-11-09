import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";
import { Button } from "./Button";
import { FormBanner } from "./FormBanner";
import { Illustration, type IllustrationName } from "./visual";

export interface EmptyStateProps {
  /** The art for this state, drawn beside the text. */
  illustration?: IllustrationName;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ illustration, title, description, action, className }: EmptyStateProps) {
  return (
    <section
      className={cn(
        illustration && "flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:gap-8",
        className,
      )}
    >
      {illustration && <Illustration name={illustration} size={185} />}
      <div className="min-w-0">
        <h2 className="text-md font-medium">{title}</h2>
        {description && <p className="mt-1 max-w-[60ch] text-muted">{description}</p>}
        {action && <div className="mt-4 flex flex-wrap gap-2">{action}</div>}
      </div>
    </section>
  );
}

export interface ErrorStateProps {
  /** What went wrong, in the server's words when it gave any. */
  message: ReactNode;
  /** Offers a way to try again when set. */
  onRetry?: () => unknown;
  className?: string;
}

/** A screen or section that could not load: the art, the reason and a way to try again. */
export function ErrorState({ message, onRetry, className }: ErrorStateProps) {
  const { t } = useTranslation("common");
  return (
    <section
      className={cn("flex max-w-[800px] flex-col items-start gap-5 sm:flex-row sm:items-center", className)}
    >
      <Illustration name="not-found" size={150} />
      <div className="grid min-w-0 flex-1 justify-items-start gap-3">
        <FormBanner>{message}</FormBanner>
        {onRetry && <Button onClick={onRetry}>{t("actions.retry")}</Button>}
      </div>
    </section>
  );
}
