import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Lamp, overallState, Pictogram } from "../../ui";
import { serviceCounts } from "../services/serviceState";
import { installsQuery } from "./api";
import { categoryPictograms } from "./category";

/** The templates installed in a project, so a multi-part install can be found again as one thing. */
export function InstallsSection({ project }: { project: string }) {
  const { t } = useTranslation("templates");
  const { data } = useQuery({ ...installsQuery(project), refetchInterval: 5000 });
  const installs = data?.installs ?? [];

  if (installs.length === 0) {
    return null;
  }
  return (
    <section className="mt-8 grid max-w-[1100px] gap-2">
      <h2 className="eyebrow">{t("install.projectHeading")}</h2>
      <ul className="border-y">
        {installs.map((install) => (
          <li key={install.id} className="border-b last:border-b-0">
            <Link
              to="/projects/$project/installs/$install"
              params={{ project, install: install.id }}
              className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-3 py-2.5 hover:bg-wash"
            >
              <Lamp
                state={
                  overallState(serviceCounts(install.components.map((part) => part.service))) ?? "stopped"
                }
                size="md"
                decorative
              />
              <Pictogram name={categoryPictograms[install.category]} className="text-muted" />
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-sm font-medium">{install.templateName}</span>
                <span className="truncate font-mono text-xs text-muted">
                  {install.components.find((part) => part.kind !== "database")?.service.name}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
