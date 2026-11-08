import { Link, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { PageHeader } from "../../ui";

/** The settings menu. A feature adds a page here with one line, and a route in `app/router.tsx`. */
const settingsMenu = [
  {
    group: "user",
    items: [{ to: "/settings/user/authentication", key: "authentication" }],
  },
  { group: "server", items: [{ to: "/settings/server/github", key: "github" }] },
] as const;

export function SettingsLayout() {
  const { t } = useTranslation("shell");
  return (
    <div className="flex min-h-full flex-col">
      <PageHeader title={t("nav.settings")} />
      <div className="md:grid md:flex-1 md:grid-cols-[200px_minmax(0,1fr)]">
        <nav
          aria-label={t("settingsNav.label")}
          className="border-b px-4 py-3 md:border-r md:border-b-0 md:py-6 md:pr-5 md:pl-6 lg:pl-8"
        >
          {settingsMenu.map((section) => (
            <div key={section.group}>
              <h2 className="eyebrow mb-1.5">{t(`settingsNav.groups.${section.group}`)}</h2>
              <ul className="grid gap-0.5">
                {section.items.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      className="relative -ml-2 flex h-7 items-center rounded-sm px-2 text-sm text-muted before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-highlight before:opacity-0 hover:bg-wash hover:text-ink data-[status=active]:text-ink data-[status=active]:before:opacity-100"
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
