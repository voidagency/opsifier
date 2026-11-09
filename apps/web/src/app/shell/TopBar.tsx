import { useQuery } from "@tanstack/react-query";
import { Link, useMatches } from "@tanstack/react-router";
import { Check, Copy, Search } from "lucide-react";
import { type ComponentType, Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../features/auth/session";
import { PanelVersion } from "../../features/panel-update/PanelVersion";
import { projectsQuery } from "../../features/projects/api";
import { ServerPurposeIndicator } from "../../features/server-purpose/ProtectionIndicator";
import type { CrumbControlProps } from "../../features/services/Crumbs";
import { serviceCounts } from "../../features/services/serviceState";
import { cn } from "../../lib/cn";
import {
  Kbd,
  Lamp,
  Mark,
  overallState,
  Pictogram,
  type PictogramName,
  problemCount,
  stateLanguage,
  Tooltip,
  useCopy,
  useDocumentTitle,
} from "../../ui";
import { setPaletteOpen } from "../commands";
import { systemInfoQuery } from "./systemInfo";
import { UserMenu } from "./UserMenu";

const primaryNav = [
  { to: "/", key: "overview", exact: true, pictogram: "node" },
  { to: "/activity", key: "activity", exact: false, pictogram: "activity" },
  { to: "/monitor", key: "monitor", exact: false, pictogram: "metrics" },
  { to: "/domains", key: "domains", exact: false, pictogram: "domain" },
  { to: "/settings", key: "settings", exact: false, pictogram: "settings" },
] as const satisfies ReadonlyArray<{ pictogram: PictogramName } & Record<string, unknown>>;

function PrimaryNav({ className }: { className?: string }) {
  const { t } = useTranslation("shell");
  const user = useCurrentUser();
  const items = primaryNav.filter((item) => item.key !== "monitor" || user?.role === "admin");
  return (
    <nav aria-label={t("nav.label")} className={cn("gap-5", className)}>
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          activeOptions={{ exact: item.exact }}
          className="relative flex h-11 shrink-0 items-center gap-1.5 text-base text-muted after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:origin-left after:scale-x-0 after:bg-accent after:transition-transform after:duration-[160ms] after:ease-out hover:text-ink data-[status=active]:text-ink data-[status=active]:after:scale-x-100"
        >
          <Pictogram name={item.pictogram} size={16} />
          {t(`nav.${item.key}`)}
        </Link>
      ))}
    </nav>
  );
}

/** How the whole server is doing, on every screen: one lamp, and how many problems there are. */
function ServerHealth() {
  const { t } = useTranslation(["shell", "visual"]);
  const { data } = useQuery({ ...projectsQuery, refetchInterval: 15_000 });
  const counts = serviceCounts(data?.projects.flatMap((project) => project.services) ?? []);
  const overall = overallState(counts);
  if (overall === null) {
    return null;
  }

  const problems = problemCount(counts);
  const label =
    problems > 0
      ? t("visual:health.problems", { count: problems })
      : overall === "running"
        ? t("visual:health.allClear")
        : t(`visual:${stateLanguage[overall].labelKey}`);

  return (
    <Tooltip content={label}>
      <Link
        to="/"
        aria-label={label}
        className="flex h-8 shrink-0 items-center gap-1 rounded-sm px-1.5 hover:bg-wash"
      >
        <Lamp state={overall} still decorative />
        {problems > 0 && <span className="font-mono text-xs tabular-nums">{problems}</span>}
      </Link>
    </Tooltip>
  );
}

interface Crumb {
  id: string;
  control?: ComponentType<CrumbControlProps>;
  label: string;
  to: string;
}

function Breadcrumb() {
  const { t } = useTranslation("shell");
  const matches = useMatches();
  const crumbs = matches.flatMap((match): Crumb[] => {
    const { crumb, crumbControl, crumbParam } = match.staticData;
    if (crumbControl !== undefined) {
      const params = match.params as Record<string, string | undefined>;
      return [
        {
          id: match.id,
          control: crumbControl,
          label: crumbParam ? (params[crumbParam] ?? "") : "",
          to: match.pathname,
        },
      ];
    }
    return crumb ? [{ id: match.id, label: t(crumb), to: match.pathname }] : [];
  });
  useDocumentTitle(crumbs.at(-1)?.label);

  return (
    <nav aria-label={t("breadcrumb")} className="min-w-0 overflow-x-clip">
      <ol className="flex min-w-0 items-center gap-1.5 text-base">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          const Control = crumb.control;
          return (
            <Fragment key={crumb.id}>
              <li aria-hidden="true" className={cn("text-off", !isLast && "hidden sm:block")}>
                /
              </li>
              <li className={cn("min-w-0", !isLast && "hidden sm:block")}>
                {Control !== undefined ? (
                  <Control isLast={isLast} />
                ) : isLast ? (
                  <span aria-current="page" className="block truncate font-medium">
                    {crumb.label}
                  </span>
                ) : (
                  <Link to={crumb.to} className="block truncate text-muted hover:text-ink">
                    {crumb.label}
                  </Link>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform);

function PaletteTrigger() {
  const { t } = useTranslation("shell");
  return (
    <button
      type="button"
      aria-label={t("palette.open")}
      onClick={() => setPaletteOpen(true)}
      className="flex size-8 items-center justify-center rounded-sm text-sm text-muted hover:text-ink min-[100rem]:h-8 min-[100rem]:w-auto min-[100rem]:justify-start min-[100rem]:gap-2 min-[100rem]:border min-[100rem]:pr-1 min-[100rem]:pl-2 min-[100rem]:hover:bg-wash"
    >
      <Search aria-hidden="true" className="size-4" />
      <span className="hidden min-[100rem]:inline">{t("palette.trigger")}</span>
      <span className="ml-3 hidden min-[100rem]:inline-flex">
        <Kbd>{isMac ? "⌘K" : "Ctrl K"}</Kbd>
      </span>
    </button>
  );
}

function ServerIpButton() {
  const { t } = useTranslation("shell");
  const { data } = useQuery(systemInfoQuery);
  const ip = data?.serverIp ?? null;
  const { copied, copy } = useCopy(ip ?? "");

  if (ip === null) {
    return null;
  }

  return (
    <Tooltip content={t("server.copyIp")}>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? t("common:copy.copied") : t("server.copyIpValue", { ip })}
        className="hidden h-8 shrink-0 items-center gap-1.5 rounded-sm px-2 text-muted hover:bg-wash hover:text-ink min-[112.5rem]:inline-flex"
      >
        {copied ? (
          <>
            <Check aria-hidden="true" className="size-3.5 text-ok" />
            <span className="text-xs">{t("common:copy.copied")}</span>
          </>
        ) : (
          <>
            <span className="font-mono text-xs text-ink">{ip}</span>
            <Copy aria-hidden="true" className="size-3" />
          </>
        )}
      </button>
    </Tooltip>
  );
}

export function TopBar() {
  const { t } = useTranslation("shell");
  return (
    <header className="brand-bar z-30 shrink-0 border-b bg-bg">
      <div className="flex h-11 items-center gap-3 px-4 md:px-6 xl:grid xl:grid-cols-[minmax(0,1fr)_auto_auto] xl:gap-6 min-[106.25rem]:grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)]">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Link to="/" aria-label={t("home")} className="flex shrink-0 items-center gap-2 rounded-sm">
            <Mark />
            <span className="hidden font-semibold text-base tracking-[-0.005em] sm:block xl:hidden min-[90rem]:block">
              Opsifier
            </span>
          </Link>
          <ServerHealth />
          <Breadcrumb />
        </div>
        <PrimaryNav className="hidden xl:flex" />
        <div className="flex items-center justify-end gap-1">
          <ServerPurposeIndicator />
          <PaletteTrigger />
          <ServerIpButton />
          <PanelVersion />
          <UserMenu />
        </div>
      </div>
      <PrimaryNav className="flex overflow-x-auto border-t px-4 [scrollbar-width:none] md:px-6 xl:hidden" />
    </header>
  );
}
