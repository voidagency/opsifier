import { Link, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../../ui";
import { useCurrentUser } from "../auth/session";

/** The settings menu. A feature adds a page here with one line, and a route in `app/router.tsx`. */
const settingsMenu = [
  {
    group: "user",
    adminOnly: false,
    items: [
      { to: "/settings/user/authentication", key: "authentication" },
      { to: "/settings/user/api-keys", key: "apiKeys" },
      { to: "/settings/user/api", key: "api" },
    ],
  },
  {
    group: "server",
    adminOnly: true,
    items: [
      { to: "/settings/server/general", key: "general" },
      { to: "/settings/server/address", key: "address" },
      { to: "/settings/server/purpose", key: "purpose" },
      { to: "/settings/server/github", key: "github" },
      { to: "/settings/server/known-hosts", key: "knownHosts" },
      { to: "/settings/server/storage-providers", key: "storageProviders" },
      { to: "/settings/server/backup", key: "backup" },
      { to: "/settings/server/users", key: "users" },
      { to: "/settings/server/notifications", key: "notifications" },
      { to: "/settings/server/certificates", key: "certificates" },
      { to: "/settings/server/monitoring", key: "monitoring" },
    ],
  },
  {
    group: "opsifier",
    adminOnly: false,
    items: [{ to: "/settings/about", key: "about" }],
  },
] as const;

export function SettingsLayout() {
  const { t } = useTranslation("shell");
  const user = useCurrentUser();
  const sections = settingsMenu.filter((section) => !section.adminOnly || user?.role === "admin");
  return (
    <div className="flex min-h-full flex-col">
      <PageHeader title={t("nav.settings")} />
      <div className="md:grid md:flex-1 md:grid-cols-[260px_minmax(0,1fr)]">
        <nav
          aria-label={t("settingsNav.label")}
          className="space-y-5 border-b px-4 py-3 md:border-r md:border-b-0 md:py-6 md:pr-5 md:pl-6 lg:pl-8"
        >
          {sections.map((section) => (
            <div key={section.group}>
              <h2 className="eyebrow mb-1.5">{t(`settingsNav.groups.${section.group}`)}</h2>
              <ul className="grid gap-0.5">
                {section.items.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      className="relative -ml-2 flex h-8 items-center rounded-sm px-2 text-base text-muted before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-highlight before:opacity-0 hover:bg-wash hover:text-ink data-[status=active]:text-ink data-[status=active]:before:opacity-100"
                    >
                      {t(`settingsNav.${item.key}`)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
