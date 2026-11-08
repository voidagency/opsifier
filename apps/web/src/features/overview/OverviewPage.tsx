import type { ProjectSummary } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, LayoutTemplate, Plus, Settings } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import {
  Button,
  EmptyState,
  FormBanner,
  HarbourFigure,
  PageHeader,
  Segmented,
  Skeleton,
  Tooltip,
} from "../../ui";
import { projectsQuery } from "../projects/api";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";
import { ServiceRow } from "../services/ServiceRow";

type Sort = "name" | "time";
type View = "expanded" | "collapsed";

const sortKey = "opsifier.overview.sort";
const viewKey = "opsifier.overview.view";

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return allowed.includes(stored as T) ? (stored as T) : fallback;
  } catch {
    return fallback;
  }
}

function usePersisted<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const [value, setValue] = useState(() => readStored(key, allowed, fallback));
  const set = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      // The choice still applies until the next reload.
    }
  };
  return [value, set] as const;
}

const compareNames = (a: ProjectSummary, b: ProjectSummary) => a.name.localeCompare(b.name);
const compareTimes = (a: ProjectSummary, b: ProjectSummary) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || compareNames(a, b);

function IconLink({
  label,
  to,
  project,
  search,
  children,
}: {
  label: string;
  to: "/projects/$project" | "/projects/$project/settings" | "/projects/$project/create";
  project: string;
  search?: { tab: "templates" };
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <Link
        to={to}
        params={{ project }}
        search={search as never}
        aria-label={label}
        className="flex size-7 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
      >
        {children}
      </Link>
    </Tooltip>
  );
}

function ProjectBlock({ project, expanded }: { project: ProjectSummary; expanded: boolean }) {
  const { t } = useTranslation("overview");
  return (
    <section aria-label={project.name} className="border-b last:border-b-0">
      <div className="flex items-center justify-between gap-3 py-2.5">
        <h2 className="min-w-0 truncate">
          <Link
            to="/projects/$project"
            params={{ project: project.name }}
            className="font-mono text-base font-medium hover:underline hover:underline-offset-4"
          >
            {project.name}
          </Link>
          <span className="ml-2 text-xs text-muted">
            {t("serviceCount", { count: project.services.length })}
          </span>
        </h2>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconLink label={t("links.view")} to="/projects/$project" project={project.name}>
            <ArrowRight aria-hidden="true" className="size-4" />
          </IconLink>
          <IconLink label={t("links.configure")} to="/projects/$project/settings" project={project.name}>
            <Settings aria-hidden="true" className="size-4" />
          </IconLink>
          <IconLink label={t("links.createService")} to="/projects/$project/create" project={project.name}>
            <Plus aria-hidden="true" className="size-4" />
          </IconLink>
          <IconLink
            label={t("links.templates")}
            to="/projects/$project/create"
            project={project.name}
            search={{ tab: "templates" }}
          >
            <LayoutTemplate aria-hidden="true" className="size-4" />
          </IconLink>
        </div>
      </div>
      {expanded &&
        (project.services.length === 0 ? (
          <p className="pb-3 text-sm text-muted">{t("noServices")}</p>
        ) : (
          <ul className="border-t pl-4">
            {project.services.map((service) => (
              <ServiceRow key={service.name} service={service} />
            ))}
          </ul>
        ))}
    </section>
  );
}

export function OverviewPage() {
  const { t } = useTranslation(["overview", "common"]);
  const { data, isPending, isError, error, refetch } = useQuery({ ...projectsQuery, refetchInterval: 5000 });
  const [sort, setSort] = usePersisted<Sort>(sortKey, ["name", "time"], "name");
  const [view, setView] = usePersisted<View>(viewKey, ["expanded", "collapsed"], "expanded");
  const [creating, setCreating] = useState(false);

  const projects = [...(data?.projects ?? [])].sort(sort === "name" ? compareNames : compareTimes);

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button
            variant="primary"
            icon={<Plus aria-hidden="true" className="size-4" />}
            onClick={() => setCreating(true)}
          >
            {t("newProject")}
          </Button>
        }
      />
      <div className="grid gap-4 px-4 py-6 md:px-6 lg:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented<Sort>
            label={t("sort.label")}
            value={sort}
            onChange={setSort}
            options={[
              { value: "name", label: t("sort.name") },
              { value: "time", label: t("sort.time") },
            ]}
          />
          <Segmented<View>
            label={t("view.label")}
            value={view}
            onChange={setView}
            options={[
              { value: "expanded", label: t("view.expanded") },
              { value: "collapsed", label: t("view.collapsed") },
            ]}
          />
        </div>
        {isPending ? (
          <div className="grid max-w-[960px] gap-3">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        ) : isError ? (
          <div className="grid max-w-[520px] justify-items-start gap-3">
            <FormBanner>{errorMessage(error, t)}</FormBanner>
            <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
          </div>
        ) : projects.length === 0 ? (
          <EmptyState
            figure={<HarbourFigure />}
            title={t("empty.title")}
            description={t("empty.description")}
            action={
              <Button
                variant="primary"
                icon={<Plus aria-hidden="true" className="size-4" />}
                onClick={() => setCreating(true)}
              >
                {t("createProject")}
              </Button>
            }
          />
        ) : (
          <div className="max-w-[960px] border-y">
            {projects.map((project) => (
              <ProjectBlock key={project.name} project={project} expanded={view === "expanded"} />
            ))}
          </div>
        )}
      </div>
      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
