import type { ProjectGrant, ProjectRole } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Checkbox, Select } from "../../../ui";
import { projectsQuery } from "../../projects/api";

/** Which projects a member reaches, and as what. */
export function GrantsEditor({
  grants,
  onChange,
}: {
  grants: ProjectGrant[];
  onChange: (next: ProjectGrant[]) => void;
}) {
  const { t } = useTranslation("settings-access");
  const { data } = useQuery(projectsQuery);
  const projects = data?.projects.map((project) => project.name) ?? [];
  const setRole = (project: string, role: ProjectRole | null) => {
    const others = grants.filter((grant) => grant.project !== project);
    onChange(role === null ? others : [...others, { project, role }]);
  };
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">{t("users.access")}</legend>
      <p className="text-xs text-muted">{t("users.accessHint")}</p>
      {projects.length === 0 ? (
        <p className="text-sm text-muted">{t("users.noProjects")}</p>
      ) : (
        <ul className="grid max-h-56 gap-1 overflow-y-auto">
          {projects.map((project) => {
            const grant = grants.find((candidate) => candidate.project === project);
            return (
              <li key={project} className="flex items-center justify-between gap-3 py-0.5">
                <Checkbox
                  label={<span className="font-mono text-xs">{project}</span>}
                  checked={grant !== undefined}
                  onChange={(event) => setRole(project, event.currentTarget.checked ? "viewer" : null)}
                />
                {grant !== undefined && (
                  <Select
                    aria-label={t("users.projectRole", { project })}
                    value={grant.role}
                    onValueChange={(value) => setRole(project, value as ProjectRole)}
                    className="h-7 w-32 text-xs"
                    options={[
                      { value: "viewer", label: t("users.roles.viewer") },
                      { value: "operator", label: t("users.roles.operator") },
                    ]}
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
