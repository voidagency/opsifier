import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../../../lib/forms";
import { Button, FormBanner, Skeleton } from "../../../../ui";
import { useServiceParams } from "../../api";
import { advancedQuery } from "./api";
import { DeployForm } from "./DeployForm";
import { PortsSection } from "./PortsSection";

const sectionClass =
  "grid gap-x-10 gap-y-4 border-b px-4 py-6 last:border-b-0 md:px-6 lg:grid-cols-[minmax(0,260px)_minmax(0,720px)] lg:px-8";

export function AdvancedTab() {
  const { t } = useTranslation(["service-advanced", "common"]);
  const { project, service } = useServiceParams();
  const { data, isPending, isError, error, refetch } = useQuery(advancedQuery(project, service));

  if (isPending) {
    return (
      <div className="grid gap-3 px-4 py-6 md:px-6 lg:px-8">
        <Skeleton className="h-40 max-w-[720px]" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="grid max-w-[520px] justify-items-start gap-3 px-4 py-6 md:px-6 lg:px-8">
        <FormBanner>{errorMessage(error, t)}</FormBanner>
        <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
      </div>
    );
  }

  return (
    <div>
      <section className={sectionClass}>
        <div>
          <h2 className="text-md font-medium">{t("ports.title")}</h2>
          <p className="mt-1 text-sm text-muted">{t("ports.description")}</p>
        </div>
        <PortsSection project={project} service={service} ports={data.ports} />
      </section>
      <section className={sectionClass}>
        <div>
          <h2 className="text-md font-medium">{t("deploy.title")}</h2>
          <p className="mt-1 text-sm text-muted">{t("deploy.description")}</p>
        </div>
        <DeployForm
          key={`${service}:${data.ports.length > 0}`}
          project={project}
          service={service}
          settings={data.deploy}
          stopped={data.stopped}
          publishesPorts={data.ports.length > 0}
        />
      </section>
    </div>
  );
}
