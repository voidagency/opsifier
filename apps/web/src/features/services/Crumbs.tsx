import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Lamp,
  Pictogram,
} from "../../ui";
import { servicePageLink } from "../databases/links";
import { projectsQuery } from "../projects/api";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";
import { servicePictogram, serviceState, serviceStateLabel, servicesState } from "./serviceState";

export interface CrumbControlProps {
  isLast: boolean;
}

const triggerClass = (isLast: boolean) =>
  cn(
    "flex max-w-full min-w-0 items-center gap-1 rounded-sm font-mono text-sm hover:text-ink data-[state=open]:text-ink",
    isLast ? "font-medium" : "text-muted",
  );

/** Switches between projects from the breadcrumb. */
export function ProjectCrumb({ isLast }: CrumbControlProps) {
  const { t } = useTranslation("services");
  const { project } = useParams({ strict: false }) as { project: string };
  const { data } = useQuery(projectsQuery);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("crumbs.switchProject", { name: project })}
          className={triggerClass(isLast)}
        >
          <span aria-current={isLast ? "page" : undefined} className="truncate">
            {project}
          </span>
          <ChevronDown aria-hidden="true" className="size-3 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[60dvh] overflow-y-auto">
          <DropdownMenuLabel>{t("crumbs.projects")}</DropdownMenuLabel>
          {data?.projects.map((item) => (
            <DropdownMenuItem key={item.name} asChild>
              <Link to="/projects/$project" params={{ project: item.name }} className="font-mono">
                <Lamp state={servicesState(item.services) ?? "unknown"} still decorative />
                {item.name}
              </Link>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/projects/$project/settings" params={{ project }}>
              {t("crumbs.projectSettings")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setCreating(true)}>{t("crumbs.newProject")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

/** Switches between the services of the current project from the breadcrumb. */
export function ServiceCrumb({ isLast }: CrumbControlProps) {
  const { t } = useTranslation(["services", "visual", "activity"]);
  const { project, service } = useParams({ strict: false }) as { project: string; service: string };
  const { data } = useQuery(projectsQuery);
  const services = data?.projects.find((item) => item.name === project)?.services ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("crumbs.switchService", { name: service })}
        className={triggerClass(isLast)}
      >
        <span aria-current={isLast ? "page" : undefined} className="truncate">
          {service}
        </span>
        <ChevronDown aria-hidden="true" className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60dvh] overflow-y-auto">
        <DropdownMenuLabel>{t("crumbs.services")}</DropdownMenuLabel>
        {services.map((item) => (
          <DropdownMenuItem key={item.name} asChild>
            <Link {...servicePageLink(project, item.name, item.type)} className="font-mono">
              <Lamp state={serviceState(item)} label={serviceStateLabel(item, t)} still />
              <Pictogram name={servicePictogram(item.type)} size={16} className="text-muted" />
              {item.name}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/projects/$project/create" params={{ project }}>
            {t("crumbs.newService")}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
