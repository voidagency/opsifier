import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../../../lib/forms";
import { ErrorState, SectionIntro, Skeleton, Switch, toast } from "../../../../ui";
import { environmentQuery, serviceKey, serviceQuery, servicesApi, useServiceParams } from "../../api";
import { EnvFileForm } from "../source/EnvFileForm";
import { BuildSection } from "./BuildSection";
import { VariablesEditor } from "./VariablesEditor";

const sectionClass =
  "grid gap-x-10 gap-y-4 px-4 py-6 md:px-6 lg:grid-cols-[minmax(0,260px)_minmax(0,720px)] lg:px-8";

/**
 * Applies by itself, unlike the variables next to it: their values stay sealed until someone asks, and
 * turning this on or off is no reason to have to.
 */
function PlaceholderSwitch({
  project,
  service,
  checked,
}: {
  project: string;
  service: string;
  checked: boolean;
}) {
  const { t } = useTranslation(["service-environment", "common"]);
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);

  const change = async (interpolation: boolean) => {
    setPending(true);
    try {
      await servicesApi.saveEnvironment(project, service, { interpolation });
      await queryClient.invalidateQueries({
        queryKey: [...serviceKey(project, service), "environment"],
      });
      toast.success(t("interpolation.saved"), t("savedHint"));
    } catch (error) {
      toast.error(t("interpolation.failed"), errorMessage(error, t));
    } finally {
      setPending(false);
    }
  };

  return (
    <Switch
      label={t("interpolation.label")}
      hint={t("interpolation.hint")}
      checked={checked}
      disabled={pending}
      onCheckedChange={(next) => void change(next)}
    />
  );
}

export function EnvironmentTab() {
  const { t } = useTranslation(["service-environment", "common"]);
  const { project, service } = useServiceParams();
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(environmentQuery(project, service));
  const { data: detail } = useQuery(serviceQuery(project, service));
  const built = detail?.source != null && detail.source.type !== "image";

  return (
    <div className="grid">
      <section className={sectionClass}>
        <SectionIntro
          pictogram="environment"
          title={t("title")}
          description={t(built ? "descriptionBuilt" : "description")}
        />
        {isPending ? (
          <Skeleton className="h-52" />
        ) : isError ? (
          <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
        ) : (
          <div className="grid max-w-[900px] gap-6">
            <VariablesEditor
              key={service}
              names={data.names}
              label={t("title")}
              submitLabel={t("submit")}
              savedTitle={t("saved")}
              savedHint={t("savedHint")}
              reveal={() => servicesApi.revealEnvironment(project, service)}
              save={(env) => servicesApi.saveEnvironment(project, service, { env })}
              onSaved={() => {
                void queryClient.invalidateQueries({
                  queryKey: [...serviceKey(project, service), "environment"],
                });
              }}
            />
            <PlaceholderSwitch project={project} service={service} checked={data.interpolation} />
          </div>
        )}
      </section>
      {built && (
        <section className={`${sectionClass} border-t`}>
          <SectionIntro
            pictogram="deployment"
            title={t("build.title")}
            description={t("build.description")}
          />
          <div className="grid max-w-[900px] gap-6">
            <BuildSection key={service} project={project} service={service} />
            <EnvFileForm project={project} service={service} />
          </div>
        </section>
      )}
    </div>
  );
}
