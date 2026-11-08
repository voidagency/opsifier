import { useTranslation } from "react-i18next";
import { EmptyState } from "../../../ui";

/** The body of a tab whose settings arrive in a later change. */
export function TabPlaceholder({ tab }: { tab: string }) {
  const { t } = useTranslation("services");
  return (
    <div className="px-4 py-6 md:px-6 lg:px-8">
      <EmptyState
        title={t("placeholder.title", { tab: t(`tabs.${tab}`) })}
        description={t(`placeholder.descriptions.${tab}`)}
      />
    </div>
  );
}
