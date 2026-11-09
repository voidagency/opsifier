import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { SectionIntro, sourceTypePictogram } from "../../../../ui";
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
      <SectionIntro
        pictogram={detail.source === null ? "git" : sourceTypePictogram[detail.source.type]}
        title={t("title")}
        description={t("description")}
      />
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
