import { useTranslation } from "react-i18next";
import { ApproachFigure, EmptyState, PageHeader } from "../../ui";

export function DomainsPage() {
  const { t } = useTranslation("domains");
  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <EmptyState
          figure={<ApproachFigure />}
          title={t("empty.title")}
          description={t("empty.description")}
        />
      </div>
    </>
  );
}
