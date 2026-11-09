import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  ConfirmDialog,
  Lamp,
  MonoValue,
  PageHeader,
  Pictogram,
  RetentionSummary,
  useDocumentTitle,
} from "../../ui";
import { projectsKey } from "../projects/api";
import { serviceQuery, servicesApi, useServiceParams } from "./api";
import { servicePictogram, serviceState, serviceStateLabel, serviceTypeLabel } from "./serviceState";
import { SourceForm } from "./tabs/source/SourceForm";

/** A new service has no source yet, so this is all it shows until one is saved. */
export function ServiceInitPage() {
  const { t } = useTranslation(["services", "visual", "activity"]);
  const { project, service } = useServiceParams();
  const { data: detail } = useQuery(serviceQuery(project, service));
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [destroying, setDestroying] = useState(false);
  useDocumentTitle(service);

  const destroy = async () => {
    await servicesApi.destroy(project, service, service);
    await queryClient.invalidateQueries({ queryKey: projectsKey });
    await navigate({ to: "/projects/$project", params: { project } });
  };

  return (
    <>
      <PageHeader
        leading={
          detail === undefined ? undefined : (
            <Lamp
              state={serviceState(detail)}
              size="xl"
              label={serviceStateLabel(detail, t)}
              className="mt-1"
            />
          )
        }
        title={
          <span className="inline-flex items-center gap-2.5">
            {detail !== undefined && (
              <Pictogram
                name={servicePictogram(detail.type)}
                size={24}
                label={serviceTypeLabel(detail.type, t)}
                className="text-muted"
              />
            )}
            <span className="font-mono">{service}</span>
          </span>
        }
        description={t("init.description")}
        actions={
          <Button variant="danger" onClick={() => setDestroying(true)}>
            {t("init.destroy")}
          </Button>
        }
      />
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <h2 className="text-md font-medium">{t("init.sourceTitle")}</h2>
        <p className="mt-1 mb-4 max-w-[60ch] text-sm text-muted">{t("init.sourceDescription")}</p>
        {detail !== undefined && (
          <SourceForm
            project={project}
            service={service}
            source={detail.source}
            submitLabel={t("init.save")}
            onSaved={() =>
              navigate({
                to: "/projects/$project/app/$service/",
                params: { project, service },
                replace: true,
              })
            }
          />
        )}
      </div>
      <ConfirmDialog
        open={destroying}
        onOpenChange={setDestroying}
        title={t("destroy.title")}
        description={
          <>
            {t("destroy.description")} <MonoValue value={service} copy copyLabel={t("destroy.copyName")} />
          </>
        }
        confirmLabel={t("destroy.confirm")}
        confirmText={service}
        onConfirm={destroy}
      >
        <RetentionSummary removed={t("destroy.removed")} kept={t("destroy.kept")} />
      </ConfirmDialog>
    </>
  );
}
