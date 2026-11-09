import type { ProjectSummary, ServiceSummary } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, LayoutTemplate, Plus, Settings } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import {
  Button,
  EmptyState,
  ErrorState,
  HealthSummary,
  Lamp,
  PageHeader,
  Segmented,
  Skeleton,
  stateLanguage,
  Tooltip,
  type VisualState,
} from "../../ui";
import { SystemGauges } from "../monitor/SystemGauges";
import { projectsQuery } from "../projects/api";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";
import { resourcesKey, type ServiceResources, useAllServiceResources } from "../service-runtime/resources";
import { ServiceChip, ServiceRow } from "../services/ServiceRow";
import {
  serviceCounts,
  serviceState,
  servicesState,
  sortServices,
  stateRank,
} from "../services/serviceState";

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

function ProjectBlock({
  project,
  services,
  expanded,
  resources,
}: {
  project: ProjectSummary;
  /** The project's services to draw, problems first. Fewer than it has while a filter is on. */
  services: readonly ServiceSummary[];
  expanded: boolean;
  resources: ReadonlyMap<string, ServiceResources>;
}) {
  const { t } = useTranslation(["overview", "visual"]);
  const state = servicesState(project.services);
  const stateName =
    state === null ? t("health.empty", { ns: "visual" }) : t(stateLanguage[state].labelKey, { ns: "visual" });

  return (
    <section aria-label={project.name} className="border-b last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
        <Lamp state={state ?? "unknown"} size="md" label={`${project.name}: ${stateName}`} />
        <h2 className="min-w-0 truncate">
          <Link
            to="/projects/$project"
            params={{ project: project.name }}
            className="font-mono text-base font-medium hover:underline hover:underline-offset-4"
          >
            {project.name}
          </Link>
        </h2>
        <div className="order-last flex w-full flex-wrap items-center gap-1.5 pl-7 sm:order-none sm:w-auto sm:pl-1">
          {project.services.length === 0 ? (
            <span className="text-xs text-muted">{t("noServices")}</span>
          ) : (
            // The rows below already link to each service, so only the summary needs links of its own.
            services.map((service) => <ServiceChip key={service.name} service={service} link={!expanded} />)
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
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
      {expanded && services.length > 0 && (
        <ul className="border-t pl-7">
          {services.map((service) => (
            <ServiceRow
              key={service.name}
              service={service}
              resources={resources.get(resourcesKey(service.projectName, service.name))}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Problems first, then in the order asked for. A filter keeps only what is in that state. */
function arrangeProjects(
  projects: readonly ProjectSummary[],
  sort: Sort,
  filter: VisualState | null,
): Array<{ project: ProjectSummary; services: ServiceSummary[] }> {
  const compare = sort === "name" ? compareNames : compareTimes;
  return [...projects]
    .sort(
      (a, b) => stateRank(servicesState(a.services)) - stateRank(servicesState(b.services)) || compare(a, b),
    )
    .map((project) => ({
      project,
      services: sortServices(
        filter === null
          ? project.services
          : project.services.filter((service) => serviceState(service) === filter),
      ),
    }))
    .filter(({ services }) => filter === null || services.length > 0);
}

export function OverviewPage() {
  const { t } = useTranslation(["overview", "common"]);
  const { data, isPending, isError, error, refetch } = useQuery({ ...projectsQuery, refetchInterval: 5000 });
  const [sort, setSort] = usePersisted<Sort>(sortKey, ["name", "time"], "name");
  const [view, setView] = usePersisted<View>(viewKey, ["expanded", "collapsed"], "expanded");
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<VisualState | null>(null);
  const resources = useAllServiceResources();

  const all = data?.projects ?? [];
  const counts = useMemo(() => serviceCounts(all.flatMap((project) => project.services)), [all]);
  const arranged = useMemo(() => arrangeProjects(all, sort, filter), [all, sort, filter]);

  return (
    <>
      <PageHeader
        title={t("title")}
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
        {isPending ? (
          <Skeleton className="h-[90px] max-w-[1400px]" />
        ) : (
          all.length > 0 && (
            <HealthSummary
              counts={counts}
              selected={filter}
              onSelect={setFilter}
              label={t("healthLabel")}
              className="max-w-[1400px]"
            />
          )
        )}
        <div className="max-w-[1400px]">
          <SystemGauges />
        </div>
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
          <div className="grid max-w-[1400px] gap-3">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        ) : isError ? (
          <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
        ) : all.length === 0 ? (
          <EmptyState
            illustration="no-projects"
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
        ) : arranged.length === 0 ? (
          <p className="text-sm text-muted">{t("noMatch")}</p>
        ) : (
          <div className="max-w-[1400px] border-y">
            {arranged.map(({ project, services }) => (
              <ProjectBlock
                key={project.name}
                project={project}
                services={services}
                expanded={view === "expanded"}
                resources={resources}
              />
            ))}
          </div>
        )}
      </div>
      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
