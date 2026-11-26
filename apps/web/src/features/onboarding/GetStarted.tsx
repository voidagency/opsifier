import type { ProjectSummary } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Compass, ExternalLink, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { systemInfoQuery } from "../../app/shell/systemInfo";
import { errorMessage } from "../../lib/forms";
import {
  Button,
  buttonClass,
  Lamp,
  Pictogram,
  type PictogramName,
  Tooltip,
  toast,
  type VisualState,
} from "../../ui";
import { useCurrentUser } from "../auth/session";
import { protectionUsersQuery, purposeQuery } from "../server-purpose/api";
import { serviceDomainQuery } from "../settings/server/api";
import { ServerAddressDialog } from "../settings/server/ServerAddressDialog";
import { isPrivateIp } from "./address";
import { setGuide, useProgress } from "./progress";
import { ensureProject, SAMPLE, type SampleApp, type SampleStage, useSampleApp } from "./sample";
import { startTour } from "./tours";

/** Whether every service there is belongs to the sample app: the guide stays until something else runs. */
export function onlySample(projects: readonly ProjectSummary[]): boolean {
  return projects.every((project) =>
    project.services.every((service) => project.name === SAMPLE.project && service.name === SAMPLE.service),
  );
}

/** Whether the guide shows: by default while nothing but the sample is deployed, for administrators. */
export function useGuideVisible(projects: readonly ProjectSummary[] | undefined): boolean {
  const user = useCurrentUser();
  const { guide } = useProgress(user?.id ?? null);
  if (user?.role !== "admin" || projects === undefined || guide === "hidden") {
    return false;
  }
  return guide === "shown" || onlySample(projects);
}

function Seconds({ from }: { from: number }) {
  const { t } = useTranslation("onboarding");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);
  return (
    // Shown, not read out: a screen reader would otherwise say every second.
    <span aria-hidden="true" className="font-mono text-xs text-muted tabular-nums">
      {t("sample.elapsed", { seconds: Math.max(0, Math.round((now - from) / 1000)) })}
    </span>
  );
}

type Four = readonly [VisualState, VisualState, VisualState, VisualState];

/** The lamps of the sample's four steps, project, install, deployment and address, at each stage. */
export function stepStates(stage: SampleStage, installed: boolean): Four {
  switch (stage) {
    case "preparing":
      return installed
        ? ["running", "running", "progress", "unknown"]
        : ["progress", "unknown", "unknown", "unknown"];
    case "deploying":
      return ["running", "running", "progress", "unknown"];
    case "live":
      return ["running", "running", "running", "running"];
    case "failed":
      return installed
        ? ["running", "running", "failed", "unknown"]
        : ["failed", "unknown", "unknown", "unknown"];
    default:
      return ["unknown", "unknown", "unknown", "unknown"];
  }
}

/** The four steps of the sample, each with its lamp, from what the server says. */
function SampleSteps({ sample }: { sample: SampleApp }) {
  const { t } = useTranslation("onboarding");
  const states = stepStates(sample.stage, sample.install !== null);
  const labels = [
    t("sample.steps.project", { project: SAMPLE.project }),
    t("sample.steps.install"),
    t("sample.steps.deploy"),
    t("sample.steps.live"),
  ];
  return (
    <ol className="grid content-start gap-1.5">
      {labels.map((label, index) => (
        <li key={label} className="flex items-center gap-2 text-sm">
          <Lamp state={states[index] ?? "unknown"} size="sm" decorative />
          <span className={states[index] === "unknown" ? "text-muted" : "text-ink"}>{label}</span>
        </li>
      ))}
    </ol>
  );
}

/** What happens on the sample's way, and what to do once it runs. */
function SampleProgress({ sample }: { sample: SampleApp }) {
  const { t } = useTranslation(["onboarding", "server-purpose"]);
  const purpose = useQuery(purposeQuery);
  const protectedServer = purpose.data?.protection === true;
  const users = useQuery({ ...protectionUsersQuery, enabled: protectedServer });
  const user = users.data?.users[0]?.username ?? null;
  const chosen = purpose.data?.purpose ?? null;
  const purposeName = chosen === null ? "" : t(`server-purpose:purposes.${chosen}`).toLowerCase();

  return (
    <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)] md:p-5">
      <SampleSteps sample={sample} />
      <p className="sr-only" aria-live="polite">
        {sample.stage === "preparing"
          ? t("sample.preparing")
          : sample.stage === "deploying"
            ? t("sample.steps.deploy")
            : sample.stage === "live"
              ? t("sample.live")
              : t("sample.failed")}
      </p>
      <div className="grid content-start gap-3">
        {sample.stage === "preparing" && <p className="text-sm">{t("sample.preparing")}</p>}
        {sample.stage === "deploying" && (
          <p className="flex flex-wrap items-baseline gap-2 text-sm">
            <span>{t("sample.deploying")}</span>
            {sample.startedAt !== null && <Seconds from={sample.startedAt} />}
          </p>
        )}
        {sample.stage === "failed" && (
          <div className="grid justify-items-start gap-2">
            <p className="text-sm text-bad">{t("sample.failed")}</p>
            {sample.error !== null && <p className="font-mono text-xs text-muted">{sample.error}</p>}
            <Button variant="primary" onClick={sample.start}>
              {t("sample.retry")}
            </Button>
          </div>
        )}
        {sample.stage === "live" && (
          <>
            <p className="text-sm font-medium">{t("sample.live")}</p>
            {sample.url !== null && (
              <p className="font-mono text-sm break-all">
                <a
                  href={sample.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-4"
                >
                  {sample.url}
                </a>
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {sample.url !== null && (
                <a
                  href={sample.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={buttonClass("primary")}
                >
                  <ExternalLink aria-hidden="true" className="size-4" />
                  {t("sample.open")}
                </a>
              )}
              {sample.service !== null && (
                <Link
                  to="/projects/$project/app/$service"
                  params={{ project: SAMPLE.project, service: sample.service.name }}
                  className={buttonClass("secondary")}
                >
                  {t("sample.inPanel")}
                </Link>
              )}
            </div>
            <p className="text-xs text-muted">{t("sample.certificate")}</p>
          </>
        )}
        {(sample.stage === "deploying" || sample.stage === "live") && chosen === null && (
          <div className="flex flex-wrap items-center gap-2 border-l-2 border-busy pl-3">
            <p className="text-sm">{t("sample.locked")}</p>
            <Link to="/settings/server/purpose" className={buttonClass("secondary", "sm")}>
              {t("sample.choose")}
            </Link>
          </div>
        )}
        {(sample.stage === "deploying" || sample.stage === "live") && chosen !== null && protectedServer && (
          <p className="border-l-2 border-rule pl-3 text-sm text-muted">
            {user === null
              ? t("sample.protectedNoUser", { purpose: purposeName })
              : t("sample.protected", { purpose: purposeName, user })}
          </p>
        )}
        {sample.stage === "live" && <p className="text-sm text-muted">{t("sample.next")}</p>}
      </div>
    </div>
  );
}

/** The domain generated names go under, as the settings show it, `*.` first. */
export const baseOf = (domain: string | null): string | null => domain?.replace(/^\*\./, "") ?? null;

/** What new apps are called here, and what to do when the server's IP leads nowhere. */
function AddressLine() {
  const { t } = useTranslation("onboarding");
  const { data: system } = useQuery(systemInfoQuery);
  const { data: domains } = useQuery(serviceDomainQuery);
  const [setting, setSetting] = useState(false);
  const ip = system?.serverIp ?? null;
  const base = baseOf(domains?.customDomain ?? domains?.defaultDomain ?? null);
  const example = base === null ? null : `https://${SAMPLE.project}-${SAMPLE.service}.${base}`;
  const sslip = base?.endsWith(".sslip.io") ?? false;
  const unreachable = ip === null || (sslip && isPrivateIp(ip));

  return (
    <div className="grid gap-2 border-b px-4 py-3 md:px-5">
      {example !== null && (
        <p className="text-sm text-muted">
          <AddressText
            template={domains?.customDomain ? "guide.addressCustom" : "guide.address"}
            example={example}
          />
        </p>
      )}
      {unreachable && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="max-w-[80ch] text-sm">
            {ip === null ? t("guide.addressUnknown") : t("guide.addressPrivate", { ip })}
          </p>
          <Button size="sm" onClick={() => setSetting(true)}>
            {t("guide.setAddress")}
          </Button>
        </div>
      )}
      <ServerAddressDialog open={setting} onOpenChange={setSetting} />
    </div>
  );
}

/** A sentence with the example address in it, drawn as a machine value. */
function AddressText({ template, example }: { template: string; example: string }) {
  const { t } = useTranslation("onboarding");
  const marker = "\u0000";
  const [before = "", after = ""] = t(template, { example: marker }).split(marker);
  return (
    <>
      {before}
      <span className="font-mono text-ink break-all">{example}</span>
      {after}
    </>
  );
}

interface WayProps {
  pictogram: PictogramName;
  title: string;
  body: string;
  action: string;
  primary?: boolean;
  onClick: () => Promise<void> | void;
}

function Way({ pictogram, title, body, action, primary = false, onClick }: WayProps) {
  return (
    <li className="grid content-start gap-2 border-t p-4 first:border-t-0 md:border-t-0 md:border-l md:p-5 md:first:border-l-0">
      <span className="flex items-center gap-2 font-medium">
        <span className="text-muted">
          <Pictogram name={pictogram} size={20} />
        </span>
        {title}
      </span>
      <span className="text-sm text-muted">{body}</span>
      <span className="mt-1">
        <Button variant={primary ? "primary" : "secondary"} onClick={onClick}>
          {action}
        </Button>
      </span>
    </li>
  );
}

/**
 * The first thing an administrator sees on a fresh panel: where apps will answer, and three ways to see
 * one running, the quickest a sample app deployed in one click. It stays until something else than the
 * sample is deployed, or until hidden; the account menu brings it back.
 */
export function GetStarted() {
  const { t } = useTranslation(["onboarding", "common"]);
  const titleId = useId();
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const sample = useSampleApp(true);
  const showProgress = sample.stage !== "idle";

  const openProject = async (tab?: "templates") => {
    try {
      const project = await ensureProject(queryClient);
      await navigate({
        to: "/projects/$project/create",
        params: { project },
        search: (tab === undefined ? {} : { tab }) as never,
      });
    } catch (failure) {
      toast.error(errorMessage(failure, t));
    }
  };

  const hide = () => {
    if (user !== null) {
      setGuide(user.id, "hidden");
      toast({ title: t("guide.hidden") });
    }
  };

  return (
    <section
      aria-labelledby={titleId}
      data-tour="get-started"
      className="max-w-[1400px] rounded-sm border bg-bg"
    >
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b px-4 py-3 md:px-5">
        <div className="min-w-[14rem] flex-1">
          <h2 id={titleId} className="text-md font-medium">
            {t("guide.title")}
          </h2>
          <p className="text-sm text-muted">{t("guide.lead")}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            icon={<Compass aria-hidden="true" className="size-4" />}
            onClick={() => startTour("panel")}
          >
            {t("guide.tour")}
          </Button>
          <Tooltip content={t("guide.hide")}>
            <button
              type="button"
              aria-label={t("guide.hide")}
              onClick={hide}
              className="flex size-8 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </Tooltip>
        </div>
      </header>
      <AddressLine />
      {showProgress ? (
        <SampleProgress sample={sample} />
      ) : (
        <ul className="grid md:grid-cols-3">
          <Way
            pictogram="deployment"
            title={t("guide.sample.title")}
            body={t("guide.sample.body")}
            action={t("guide.sample.action")}
            primary
            onClick={sample.start}
          />
          <Way
            pictogram="template"
            title={t("guide.templates.title")}
            body={t("guide.templates.body")}
            action={t("guide.templates.action")}
            onClick={() => openProject("templates")}
          />
          <Way
            pictogram="image"
            title={t("guide.own.title")}
            body={t("guide.own.body")}
            action={t("guide.own.action")}
            onClick={() => openProject()}
          />
        </ul>
      )}
    </section>
  );
}
