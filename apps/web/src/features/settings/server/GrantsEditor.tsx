import {
  effectiveProjectRole,
  type ProjectGrant,
  type ProjectRole,
  projectRoleRank,
  projectRoles,
  type UserRole,
} from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Checkbox, Select } from "../../../ui";
import { projectsQuery } from "../../projects/api";

/** The strongest role: held in every project, there is nothing left to give project by project. */
const STRONGEST: ProjectRole = projectRoles[projectRoles.length - 1] ?? "maintainer";

/** What a member reaches, in a form both an account and an invitation have. */
export interface MemberReach {
  role: UserRole;
  allProjects: ProjectRole | null;
  projects: readonly ProjectGrant[];
}

/** One line saying what an account or an invitation reaches. */
export function reachSummary(reach: MemberReach, t: TFunction): string {
  if (reach.role === "admin") {
    return t("users.everyProject");
  }
  if (reach.allProjects === null) {
    return t("users.projectCount", { count: reach.projects.length });
  }
  const everywhere = t("users.everyProjectAs", { role: t(`users.roles.${reach.allProjects}`) });
  const floor = projectRoleRank(reach.allProjects);
  const raised = reach.projects.filter((grant) => projectRoleRank(grant.role) > floor).length;
  return raised === 0 ? everywhere : `${everywhere} · ${t("users.raisedIn", { count: raised })}`;
}

/**
 * A choice of project role, one width wherever it stands so the menus line up. `atLeast` leaves out
 * the roles below one the member holds anyway, which would change nothing.
 */
export function RoleSelect({
  label,
  value,
  onChange,
  atLeast = null,
}: {
  label: string;
  value: ProjectRole;
  onChange: (role: ProjectRole) => void;
  atLeast?: ProjectRole | null;
}) {
  const { t } = useTranslation("settings-access");
  const floor = projectRoleRank(atLeast);
  return (
    // The width lives on a wrapper: a control is as wide as what holds it.
    <div className="w-32 shrink-0">
      <Select
        aria-label={label}
        value={value}
        onValueChange={(next) => onChange(next as ProjectRole)}
        className="h-7 text-xs"
        options={projectRoles
          .filter((role) => projectRoleRank(role) >= floor)
          .map((role) => ({ value: role, label: t(`users.roles.${role}`) }))}
      />
    </div>
  );
}

/**
 * Which projects a member reaches, and as what: a role in every project, those created later
 * included, and each project's own role. A project gets the stronger of the two.
 */
export function GrantsEditor({
  grants,
  onChange,
  allProjects,
  onAllProjectsChange,
}: {
  grants: ProjectGrant[];
  onChange: (next: ProjectGrant[]) => void;
  allProjects: ProjectRole | null;
  onAllProjectsChange: (next: ProjectRole | null) => void;
}) {
  const { t } = useTranslation("settings-access");
  const { data } = useQuery(projectsQuery);
  const projects = data?.projects.map((project) => project.name) ?? [];
  const setRole = (project: string, role: ProjectRole | null) => {
    const others = grants.filter((grant) => grant.project !== project);
    onChange(role === null ? others : [...others, { project, role }]);
  };
  const ownRole = (project: string) => grants.find((candidate) => candidate.project === project)?.role;

  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">{t("users.access")}</legend>
      <p className="text-xs text-muted">{t("users.accessHint")}</p>
      <div className="flex items-start justify-between gap-3 border-b pb-2">
        <Checkbox
          label={t("users.allProjects")}
          hint={t("users.allProjectsHint")}
          checked={allProjects !== null}
          onChange={(event) => onAllProjectsChange(event.currentTarget.checked ? "viewer" : null)}
        />
        {allProjects !== null && (
          <RoleSelect label={t("users.allProjectsRole")} value={allProjects} onChange={onAllProjectsChange} />
        )}
      </div>
      {allProjects === STRONGEST ? (
        // Nothing is stronger, so there is nothing to choose project by project. The list comes back,
        // as it was, when the box is unticked.
        <p className="text-sm text-muted">{t("users.allMaintainer")}</p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-muted">{t("users.noProjects")}</p>
      ) : allProjects !== null ? (
        <>
          <p className="text-xs text-muted">
            {t("users.raiseHint", { role: t(`users.roles.${allProjects}`) })}
          </p>
          <ul className="grid max-h-56 gap-1 overflow-y-auto">
            {projects.map((project) => (
              <li key={project} className="flex items-center justify-between gap-3 py-0.5">
                <span className="font-mono text-xs">{project}</span>
                <RoleSelect
                  label={t("users.projectRole", { project })}
                  value={effectiveProjectRole(allProjects, ownRole(project)) ?? allProjects}
                  atLeast={allProjects}
                  // What every project has already needs no role of its own, so only a raise is kept.
                  onChange={(role) =>
                    setRole(project, projectRoleRank(role) > projectRoleRank(allProjects) ? role : null)
                  }
                />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <ul className="grid max-h-56 gap-1 overflow-y-auto">
          {projects.map((project) => {
            const role = ownRole(project);
            return (
              <li key={project} className="flex items-center justify-between gap-3 py-0.5">
                <Checkbox
                  label={<span className="font-mono text-xs">{project}</span>}
                  checked={role !== undefined}
                  onChange={(event) => setRole(project, event.currentTarget.checked ? "viewer" : null)}
                />
                {role !== undefined && (
                  <RoleSelect
                    label={t("users.projectRole", { project })}
                    value={role}
                    onChange={(next) => setRole(project, next)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}
