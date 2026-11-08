import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { serviceQuery, useServiceParams } from "../../api";
import { SourceForm } from "./SourceForm";

export function SourceTab() {
  const { t } = useTranslation("service-source");
  const { project, service } = useServiceParams();
  const { data: detail } = useQuery(serviceQuery(project, service));

  if (detail === undefined) {
    return null;
  }

  return (
    <section className="grid gap-x-10 gap-y-4 px-4 py-6 md:px-6 lg:grid-cols-[minmax(0,260px)_minmax(0,720px)] lg:px-8">
      <div>
        <h2 className="text-md font-medium">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted">{t("description")}</p>
      </div>
      <SourceForm
        key={JSON.stringify(detail.source)}
        project={project}
        service={service}
        source={detail.source}
        submitLabel={t("submit")}
      />
    </section>
  );
}
