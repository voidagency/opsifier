import { effectiveProjectRole, type ProjectGrant, type ProjectRole, type UserRole } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Checkbox, Select } from "../../../ui";
import { projectsQuery } from "../../projects/api";

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
  const raised =
    reach.allProjects === "viewer" ? reach.projects.filter((grant) => grant.role === "operator").length : 0;
  return raised === 0 ? everywhere : `${everywhere} · ${t("users.operatorIn", { count: raised })}`;
}

/** A choice of project role, one width wherever it stands so the menus line up. */
export function RoleSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ProjectRole;
  onChange: (role: ProjectRole) => void;
}) {
  const { t } = useTranslation("settings-access");
  return (
    // The width lives on a wrapper: a control is as wide as what holds it.
    <div className="w-32 shrink-0">
      <Select
        aria-label={label}
        value={value}
        onValueChange={(next) => onChange(next as ProjectRole)}
        className="h-7 text-xs"
        options={[
          { value: "viewer", label: t("users.roles.viewer") },
          { value: "operator", label: t("users.roles.operator") },
        ]}
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
      {allProjects === "operator" ? (
        // Nothing is stronger, so there is nothing to choose project by project. The list comes back,
        // as it was, when the box is unticked.
        <p className="text-sm text-muted">{t("users.allOperator")}</p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-muted">{t("users.noProjects")}</p>
      ) : allProjects === "viewer" ? (
        <>
          <p className="text-xs text-muted">{t("users.raiseHint")}</p>
          <ul className="grid max-h-56 gap-1 overflow-y-auto">
            {projects.map((project) => (
              <li key={project} className="flex items-center justify-between gap-3 py-0.5">
                <span className="font-mono text-xs">{project}</span>
                <RoleSelect
                  label={t("users.projectRole", { project })}
                  value={effectiveProjectRole(allProjects, ownRole(project)) ?? allProjects}
                  // Viewer is what every project has already, so only a raise is kept.
                  onChange={(role) => setRole(project, role === "operator" ? "operator" : null)}
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
