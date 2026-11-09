import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { type PaletteCommand, useRegisterCommands } from "../../app/commands";
import type { PictogramName } from "../../ui";
import { useCurrentUser } from "../auth/session";
import { servicePageLink } from "../databases/links";
import { projectsQuery } from "../projects/api";

interface Destination {
  key: string;
  label: string;
  to: string;
  group: "user" | "server";
  pictogram: PictogramName;
  keywords: string[];
}

const destinations: readonly Destination[] = [
  {
    key: "authentication",
    label: "settingsNav.authentication",
    to: "/settings/user/authentication",
    group: "user",
    pictogram: "access",
    keywords: ["password", "two-factor"],
  },
  {
    key: "apiKeys",
    label: "settingsNav.apiKeys",
    to: "/settings/user/api-keys",
    group: "user",
    pictogram: "access",
    keywords: ["token", "api"],
  },
  {
    key: "api",
    label: "settingsNav.api",
    to: "/settings/user/api",
    group: "user",
    pictogram: "settings",
    keywords: ["openapi", "rest", "reference"],
  },
  {
    key: "general",
    label: "settingsNav.general",
    to: "/settings/server/general",
    group: "server",
    pictogram: "settings",
    keywords: ["panel", "traefik", "docker", "reboot", "prune", "console", "disk"],
  },
  {
    key: "github",
    label: "settingsNav.github",
    to: "/settings/server/github",
    group: "server",
    pictogram: "git",
    keywords: ["token", "git"],
  },
  {
    key: "address",
    label: "settingsNav.address",
    to: "/settings/server/address",
    group: "server",
    pictogram: "domain",
    keywords: ["dns", "domain", "sslip", "heartbeat", "wildcard"],
  },
  {
    key: "users",
    label: "settingsNav.users",
    to: "/settings/server/users",
    group: "server",
    pictogram: "user",
    keywords: ["accounts", "members", "access"],
  },
  {
    key: "notifications",
    label: "settingsNav.notifications",
    to: "/settings/server/notifications",
    group: "server",
    pictogram: "notification",
    keywords: ["alerts", "webhook", "discord", "slack", "telegram", "email"],
  },
  {
    key: "certificates",
    label: "settingsNav.certificates",
    to: "/settings/server/certificates",
    group: "server",
    pictogram: "certificate",
    keywords: ["tls", "https", "acme"],
  },
  {
    key: "monitoring",
    label: "settingsNav.monitoring",
    to: "/settings/server/monitoring",
    group: "server",
    pictogram: "metrics",
    keywords: ["retention", "metrics", "logs"],
  },
];

/** Puts every settings page, project and service in the palette, and the drill-down into projects. */
export function usePlatformCommands(): void {
  const { t } = useTranslation("shell");
  const navigate = useNavigate();
  const user = useCurrentUser();
  const { data } = useQuery(projectsQuery);

  const commands = useMemo<PaletteCommand[]>(() => {
    const isAdmin = user?.role === "admin";
    const projects = data?.projects ?? [];
    const projectsGroup = t("palette.groups.projects");
    const servicesGroup = t("palette.groups.services");
    const openLink = (link: unknown) => () => void navigate(link as never);

    const serviceCommand = (project: string, service: { name: string; type: string }): PaletteCommand => ({
      id: `service.${project}/${service.name}`,
      group: servicesGroup,
      title: `${project} / ${service.name}`,
      pictogram: "app",
      hint: service.type,
      keywords: [project, service.name],
      run: openLink(servicePageLink(project, service.name, service.type)),
    });

    const projectCommands = projects.map<PaletteCommand>((project) => ({
      id: `project.${project.name}`,
      group: projectsGroup,
      title: project.name,
      pictogram: "node",
      hint: String(project.services.length),
      keywords: [project.name],
      children: () => [
        {
          id: `project.open.${project.name}`,
          group: projectsGroup,
          title: project.name,
          pictogram: "node",
          keywords: [project.name],
          run: openLink({ to: "/projects/$project", params: { project: project.name } }),
        },
        ...project.services.map((service) => serviceCommand(project.name, service)),
      ],
      run: () => {},
    }));

    return [
      {
        id: "go.settings",
        group: t("palette.groups.navigation"),
        title: t("nav.settings"),
        pictogram: "settings",
        keywords: ["settings"],
        run: () => void navigate({ to: "/settings" }),
      },
      {
        id: "go.projects",
        group: t("palette.groups.navigation"),
        title: projectsGroup,
        pictogram: "node",
        keywords: ["projects"],
        children: () => projectCommands,
        run: () => {},
      },
      ...projectCommands,
      ...projects.flatMap((project) =>
        project.services.map((service) => serviceCommand(project.name, service)),
      ),
      ...destinations
        .filter((destination) => destination.group === "user" || isAdmin)
        .map<PaletteCommand>((destination) => ({
          id: `settings.${destination.key}`,
          group: t(`palette.groups.${destination.group}`),
          title: t(destination.label),
          pictogram: destination.pictogram,
          keywords: destination.keywords,
          run: () => void navigate({ to: destination.to as never }),
        })),
    ];
  }, [t, navigate, user?.role, data]);

  useRegisterCommands(commands);
}
