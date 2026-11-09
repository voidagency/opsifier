import { deployActionType, type ServiceDetail } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
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
  MonoValue,
  RetentionSummary,
  Skeleton,
  Tooltip,
  toast,
  useDocumentTitle,
} from "../../ui";
import { projectsKey } from "../projects/api";
import { ConsoleButton, LogsButton } from "../service-runtime/RuntimeButtons";
import { useActionFollower } from "./ActionFollower";
import { serviceKey, serviceQuery, servicesApi, useServiceParams } from "./api";
import { NotesDialog } from "./NotesDialog";
import { RenameDialog } from "./RenameDialog";
import { ServiceHeader, TabPictogram, tabLinkClass } from "./ServiceHeader";
import { serviceTabs } from "./tabs";

function TabNav({ project, service }: { project: string; service: string }) {
  const { t } = useTranslation("services");
  return (
    <nav
      aria-label={t("tabs.label")}
      className="-mb-px flex gap-x-5 overflow-x-auto [scrollbar-width:none] md:flex-wrap md:overflow-visible"
    >
      {serviceTabs.map((tab) => (
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

export function ServiceToolbar({ detail }: { detail: ServiceDetail }) {
  const { t } = useTranslation(["services", "activity", "common"]);
  const { project, service } = useServiceParams();
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

  /** Starts an Action and reports its end, without marking anything done before the server does. */
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

  const deploy = (options?: { force?: boolean }) =>
    start(
      () => servicesApi.deploy(project, service, options),
      t("toolbar.deployed"),
      t("toolbar.deployFailed"),
    );
  const stop = () =>
    start(() => servicesApi.stop(project, service), t("toolbar.stopped"), t("toolbar.stopFailed"));
  const startService = () =>
    start(() => servicesApi.start(project, service), t("toolbar.started"), t("toolbar.startFailed"));
  const restart = () =>
    start(() => servicesApi.restart(project, service), t("toolbar.restarted"), t("toolbar.restartFailed"));

  const destroy = async () => {
    await servicesApi.destroy(project, service, service);
    await queryClient.invalidateQueries({ queryKey: projectsKey });
    toast({ title: t("destroy.started", { name: service }) });
    await navigate({ to: "/projects/$project", params: { project } });
  };

  const busyReason = busy ? t("toolbar.busy") : undefined;
  const startStopReason = deployed ? busyReason : t("toolbar.notDeployed");

  return (
    <>
      <Button
        variant="primary"
        icon={<Rocket aria-hidden="true" className="size-4" />}
        pending={deploying}
        disabledReason={deploying ? undefined : busyReason}
        onClick={() => deploy()}
      >
        {t("toolbar.deploy")}
      </Button>
      <Button
        size="icon"
        aria-label={stopped ? t("toolbar.start") : t("toolbar.stop")}
        tooltip={stopped ? t("toolbar.start") : t("toolbar.stop")}
        disabledReason={startStopReason}
        onClick={stopped ? startService : stop}
      >
        {stopped ? (
          <Play aria-hidden="true" className="size-4" />
        ) : (
          <Square aria-hidden="true" className="size-4" />
        )}
      </Button>
      <Button
        size="icon"
        aria-label={t("toolbar.restart")}
        tooltip={t("toolbar.restart")}
        disabledReason={startStopReason ?? (stopped ? t("toolbar.startFirst") : undefined)}
        onClick={restart}
      >
        <RotateCw aria-hidden="true" className="size-4" />
      </Button>
      <LogsButton project={project} service={service} />
      <ConsoleButton project={project} service={service} running={detail.replicas.running > 0} />
      {detail.primaryUrl === null ? (
        <Button size="icon" aria-label={t("toolbar.open")} disabledReason={t("toolbar.noDomain")}>
          <ExternalLink aria-hidden="true" className="size-4" />
        </Button>
      ) : (
        <Tooltip content={t("toolbar.open")}>
          <a
            href={detail.primaryUrl}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={t("toolbar.open")}
            className="flex size-8 items-center justify-center rounded-sm border border-off hover:bg-wash"
          >
            <ExternalLink aria-hidden="true" className="size-4" />
          </a>
        </Tooltip>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("toolbar.more")}
          className="flex size-8 items-center justify-center rounded-sm border border-off hover:bg-wash data-[state=open]:bg-wash"
        >
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => setNotesOpen(true)}>{t("toolbar.notes")}</DropdownMenuItem>
          <DropdownMenuItem disabledReason={busyReason} onSelect={() => deploy({ force: true })}>
            {t("toolbar.rebuild")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => setDestroyOpen(true)}>
            {t("toolbar.destroy")}
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
            {t("destroy.description")} <MonoValue value={service} copy copyLabel={t("destroy.copyName")} />
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

/** The frame of every service tab: identity, toolbar, readings and the tab strip. */
export function ServiceLayout() {
  const { t } = useTranslation("services");
  const { project, service } = useServiceParams();
  const {
    data: detail,
    error,
    refetch,
  } = useQuery({ ...serviceQuery(project, service), refetchInterval: 3000 });
  const [renaming, setRenaming] = useState(false);
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
      <ServiceHeader
        project={project}
        service={service}
        detail={detail}
        toolbar={<ServiceToolbar detail={detail} />}
        tabs={<TabNav project={project} service={service} />}
        onRename={() => setRenaming(true)}
      />
      <Outlet />
      <RenameDialog project={project} service={service} open={renaming} onOpenChange={setRenaming} />
    </>
  );
}
