import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { LayoutTemplate, Plus, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import {
  Button,
  buttonClass,
  EmptyState,
  FormBanner,
  HarbourFigure,
  PageHeader,
  Skeleton,
  useDocumentTitle,
} from "../../ui";
import { ServiceRow } from "../services/ServiceRow";
import { projectQuery } from "./api";

const route = getRouteApi("/app/projects/$project/");

export function ProjectPage() {
  const { t } = useTranslation(["projects", "common"]);
  const { project } = route.useParams();
  const { data, isPending, isError, error, refetch } = useQuery({
    ...projectQuery(project),
    refetchInterval: 3000,
  });
  useDocumentTitle(project);

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
      <PageHeader title={<span className="font-mono">{project}</span>} actions={actions} />
      <div className="px-4 py-6 md:px-6 lg:px-8">
        {isPending ? (
          <div className="grid max-w-[880px] gap-3">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        ) : isError ? (
          <div className="grid max-w-[520px] justify-items-start gap-3">
            <FormBanner>{errorMessage(error, t)}</FormBanner>
            <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
          </div>
        ) : data.services.length === 0 ? (
          <EmptyState
            figure={<HarbourFigure />}
            title={t("page.emptyTitle")}
            description={t("page.emptyDescription")}
          />
        ) : (
          <ul className="max-w-[880px] border-y">
            {data.services.map((service) => (
              <ServiceRow key={service.name} service={service} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
