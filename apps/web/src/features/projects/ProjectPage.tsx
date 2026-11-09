import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { LayoutTemplate, Plus, Settings } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import {
  buttonClass,
  EmptyState,
  ErrorState,
  HealthSummary,
  Lamp,
  PageHeader,
  Skeleton,
  stateLanguage,
  useDocumentTitle,
  type VisualState,
} from "../../ui";
import { resourcesKey, useAllServiceResources } from "../service-runtime/resources";
import { ServiceRow } from "../services/ServiceRow";
import { serviceCounts, serviceState, servicesState, sortServices } from "../services/serviceState";
import { InstallsSection } from "../templates/InstallsSection";
import { projectQuery } from "./api";

const route = getRouteApi("/app/projects/$project/");

export function ProjectPage() {
  const { t } = useTranslation(["projects", "common", "visual"]);
  const { project } = route.useParams();
  const { data, isPending, isError, error, refetch } = useQuery({
    ...projectQuery(project),
    refetchInterval: 3000,
  });
  const [filter, setFilter] = useState<VisualState | null>(null);
  const resources = useAllServiceResources();
  useDocumentTitle(project);

  const counts = useMemo(() => serviceCounts(data?.services ?? []), [data]);
  const state = servicesState(data?.services ?? []);
  const services = useMemo(
    () =>
      sortServices(
        (data?.services ?? []).filter((service) => filter === null || serviceState(service) === filter),
      ),
    [data, filter],
  );

  const actions = (
    <>
      <Link to="/projects/$project/create" params={{ project }} className={buttonClass("primary", "md")}>
        <Plus aria-hidden="true" className="size-4" />
        {t("page.newService")}
      </Link>
      <Link
        to="/projects/$project/create"
        params={{ project }}
        search={{ tab: "templates" }}
        className={buttonClass("secondary", "md")}
      >
        <LayoutTemplate aria-hidden="true" className="size-4" />
        {t("page.templates")}
      </Link>
      <Link to="/projects/$project/settings" params={{ project }} className={buttonClass("secondary", "md")}>
        <Settings aria-hidden="true" className="size-4" />
        {t("page.settings")}
      </Link>
    </>
  );

  return (
    <>
      <PageHeader
        leading={
          <Lamp
            state={state ?? "unknown"}
            size="lg"
            label={`${project}: ${
              state === null ? t("visual:health.empty") : t(`visual:${stateLanguage[state].labelKey}`)
            }`}
            className="mt-1"
          />
        }
        title={<span className="font-mono">{project}</span>}
        description={
          data !== undefined && data.services.length > 0 ? (
            <HealthSummary
              variant="row"
              counts={counts}
              selected={filter}
              onSelect={setFilter}
              label={t("page.healthLabel")}
              className="-ml-1.5 align-middle"
            />
          ) : undefined
        }
        actions={actions}
      />
      <div className="px-4 py-6 md:px-6 lg:px-8">
        {isPending ? (
          <div className="grid max-w-[1400px] gap-3">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        ) : isError ? (
          <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
        ) : data.services.length === 0 ? (
          <EmptyState
            illustration="no-services"
            title={t("page.emptyTitle")}
            description={t("page.emptyDescription")}
          />
        ) : services.length === 0 ? (
          <p className="text-sm text-muted">{t("page.noMatch")}</p>
        ) : (
          <ul className="max-w-[1400px] border-y">
            {services.map((service) => (
              <ServiceRow
                key={service.name}
                service={service}
                resources={resources.get(resourcesKey(service.projectName, service.name))}
              />
            ))}
          </ul>
        )}
        <InstallsSection project={project} />
      </div>
    </>
  );
}
