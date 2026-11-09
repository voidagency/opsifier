import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export interface RetentionSummaryProps {
  removed: ReactNode;
  kept: ReactNode;
}

/** What a deletion takes with it and what it leaves, said the same way in every dialog. */
export function RetentionSummary({ removed, kept }: RetentionSummaryProps) {
  const { t } = useTranslation("common");
  return (
    <dl className="grid gap-2 text-sm">
      <div>
        <dt className="font-medium">{t("retention.removed")}</dt>
        <dd className="text-muted">{removed}</dd>
      </div>
      <div>
        <dt className="font-medium">{t("retention.kept")}</dt>
        <dd className="text-muted">{kept}</dd>
      </div>
    </dl>
  );
}
