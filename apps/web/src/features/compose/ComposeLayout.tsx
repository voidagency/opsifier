import { deployActionType, type ServiceDetail } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { ExternalLink, MoreHorizontal, Play, Rocket, RotateCw, Square } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ErrorState,
  Lamp,
  MonoValue,
  PageHeader,
  Pictogram,
  RetentionSummary,
  Skeleton,
  Tooltip,
  toast,
  useDocumentTitle,
  WakeStrip,
} from "../../ui";
import { projectsKey } from "../projects/api";
import { MetricsRow } from "../service-runtime/MetricsRow";
import { ConsoleButton, LogsButton } from "../service-runtime/RuntimeButtons";
import { useActionFollower } from "../services/ActionFollower";
import { serviceKey, serviceQuery, servicesApi, useServiceParams } from "../services/api";
import { NotesDialog } from "../services/NotesDialog";
import { TabPictogram, tabLinkClass } from "../services/ServiceHeader";
import { RuntimeNotice, ServiceFlags } from "../services/ServiceNotice";
import { ReplicaPips } from "../services/ServiceRow";
import { serviceState, serviceStateLabel } from "../services/serviceState";
import { composeTabs } from "./tabs";

/** The project and stack the current route is about. */
export function useComposeParams(): { project: string; service: string } {
  return useParams({ strict: false }) as { project: string; service: string };
}

function ComposeTabNav() {
  const { t } = useTranslation("compose");
  const { project, service } = useComposeParams();
  return (
    <nav
      aria-label={t("tabs.label")}
      className="-mb-px flex gap-x-5 overflow-x-auto [scrollbar-width:none] md:flex-wrap md:overflow-visible"
    >
      {composeTabs.map((tab) => (
        <Link
          key={tab.key}
          to={tab.to}
          params={{ project, service }}
          activeOptions={{ exact: tab.key === "overview", includeHash: false, includeSearch: false }}
          className={tabLinkClass}
        >
          <TabPictogram tab={tab.key} />
          {t(`tabs.${tab.key}`)}
        </Link>
      ))}
    </nav>
  );
}

function ComposeToolbar({ detail }: { detail: ServiceDetail }) {
  const { t } = useTranslation(["compose", "services", "common"]);
  const { project, service } = useComposeParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const follow = useActionFollower();
  const [notesOpen, setNotesOpen] = useState(false);
  const [destroyOpen, setDestroyOpen] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
  const busy = detail.activeAction !== null;
  const deploying = detail.activeAction?.type === deployActionType;
  const stopped = detail.status === "stopped" || detail.stopped;
  const deployed = detail.status !== "undeployed";

  const start = async (run: () => Promise<{ id: string }>, success: string, failure: string) => {
    try {
      const action = await run();
      follow(action.id, {
        success: () => toast.success(success),
        failure: (ended) => toast.error(failure, ended.error ?? undefined),
      });
    } catch (error) {
      toast.error(failure, errorMessage(error, t));
    }
    await refresh();
  };

  const deploy = (force?: boolean) =>
    start(
      () => servicesApi.deploy(project, service, force === true ? { force: true } : {}),
      t("services:toolbar.deployed"),
      t("services:toolbar.deployFailed"),
    );

  const destroy = async () => {
    await servicesApi.destroy(project, service, service);
    await queryClient.invalidateQueries({ queryKey: projectsKey });
    toast({ title: t("services:destroy.started", { name: service }) });
    await navigate({ to: "/projects/$project", params: { project } });
  };

  const busyReason = busy ? t("services:toolbar.busy") : undefined;
  const startStopReason = deployed ? busyReason : t("services:toolbar.notDeployed");

  return (
    <>
      <Button
        variant="primary"
        icon={<Rocket aria-hidden="true" className="size-4" />}
        pending={deploying}
        disabledReason={deploying ? undefined : busyReason}
        onClick={() => deploy()}
      >
        {t("services:toolbar.deploy")}
      </Button>
      <Button
        size="icon"
        aria-label={stopped ? t("services:toolbar.start") : t("services:toolbar.stop")}
        tooltip={stopped ? t("services:toolbar.start") : t("services:toolbar.stop")}
        disabledReason={startStopReason}
        onClick={() =>
          stopped
            ? start(
                () => servicesApi.start(project, service),
                t("services:toolbar.started"),
                t("services:toolbar.startFailed"),
              )
            : start(
                () => servicesApi.stop(project, service),
                t("services:toolbar.stopped"),
                t("services:toolbar.stopFailed"),
              )
        }
      >
        {stopped ? (
          <Play aria-hidden="true" className="size-4" />
        ) : (
          <Square aria-hidden="true" className="size-4" />
        )}
      </Button>
      <Button
        size="icon"
        aria-label={t("services:toolbar.restart")}
        tooltip={t("services:toolbar.restart")}
        disabledReason={startStopReason ?? (stopped ? t("services:toolbar.startFirst") : undefined)}
        onClick={() =>
          start(
            () => servicesApi.restart(project, service),
            t("services:toolbar.restarted"),
            t("services:toolbar.restartFailed"),
          )
        }
      >
        <RotateCw aria-hidden="true" className="size-4" />
      </Button>
      <LogsButton project={project} service={service} />
      <ConsoleButton project={project} service={service} running={detail.replicas.running > 0} />
      {detail.primaryUrl === null ? (
        <Button
          size="icon"
          aria-label={t("services:toolbar.open")}
          disabledReason={t("services:toolbar.noDomain")}
        >
          <ExternalLink aria-hidden="true" className="size-4" />
        </Button>
      ) : (
        <Tooltip content={t("services:toolbar.open")}>
          <a
            href={detail.primaryUrl}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={t("services:toolbar.open")}
            className="flex size-8 items-center justify-center rounded-sm border border-off hover:bg-wash"
          >
            <ExternalLink aria-hidden="true" className="size-4" />
          </a>
        </Tooltip>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("services:toolbar.more")}
          className="flex size-8 items-center justify-center rounded-sm border border-off hover:bg-wash data-[state=open]:bg-wash"
        >
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => setNotesOpen(true)}>
            {t("services:toolbar.notes")}
          </DropdownMenuItem>
          <DropdownMenuItem disabledReason={busyReason} onSelect={() => deploy(true)}>
            {t("services:toolbar.rebuild")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => setDestroyOpen(true)}>
            {t("services:toolbar.destroy")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NotesDialog
        project={project}
        service={service}
        notes={detail.notes}
        open={notesOpen}
        onOpenChange={setNotesOpen}
      />
      <ConfirmDialog
        open={destroyOpen}
        onOpenChange={setDestroyOpen}
        title={t("destroy.title")}
        description={
          <>
            {t("destroy.description")}{" "}
            <MonoValue value={service} copy copyLabel={t("services:destroy.copyName")} />
          </>
        }
        confirmLabel={t("destroy.confirm")}
        confirmText={service}
        onConfirm={destroy}
      >
        <RetentionSummary removed={t("destroy.removed")} kept={t("destroy.kept")} />
      </ConfirmDialog>
    </>
  );
}

/** The frame of every stack tab: what it is, how it is doing, its toolbar and its tabs. */
export function ComposeLayout() {
  const { t } = useTranslation(["compose", "services", "visual", "activity"]);
  const { project, service } = useServiceParams();
  const {
    data: detail,
    error,
    refetch,
  } = useQuery({ ...serviceQuery(project, service), refetchInterval: 3000 });
  useDocumentTitle(service);

  if (detail === undefined) {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        {error ? (
          <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
        ) : (
          <Skeleton className="h-16" />
        )}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        leading={<Lamp state={serviceState(detail)} size="xl" decorative className="mt-1" />}
        title={
          <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span title={t("type")} className="inline-flex text-muted">
              <Pictogram name="compose" size={24} label={t("type")} />
            </span>
            <span className="font-mono">{service}</span>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-sm font-medium text-ink">{serviceStateLabel(detail, t)}</span>
            <ReplicaPips {...detail.replicas} />
            <WakeStrip
              outcomes={detail.wake}
              label={t("services:rows.wakeLabel", { count: detail.wake.length })}
            />
            <ServiceFlags detail={detail} />
          </span>
        }
        actions={<ComposeToolbar detail={detail} />}
      >
        <RuntimeNotice detail={detail} />
        <MetricsRow key={`${project}/${service}`} project={project} service={service} />
        <ComposeTabNav />
      </PageHeader>
      <Outlet />
    </>
  );
}
