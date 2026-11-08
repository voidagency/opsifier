import { deployActionType, type ServiceDetail } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { ExternalLink, MoreHorizontal, Pencil, Play, Rocket, RotateCw, Square } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import {
  Badge,
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FormBanner,
  MonoValue,
  PageHeader,
  Skeleton,
  StatusLamp,
  Tooltip,
  toast,
  useDocumentTitle,
} from "../../ui";
import { actionLabel } from "../activity/labels";
import { projectsKey } from "../projects/api";
import { MetricsRow } from "../service-runtime/MetricsRow";
import { ConsoleButton, LogsButton } from "../service-runtime/RuntimeButtons";
import { useActionFollower } from "./ActionFollower";
import {
  lampForService,
  serviceKey,
  serviceQuery,
  servicesApi,
  statusLabelKey,
  useServiceParams,
} from "./api";
import { NotesDialog } from "./NotesDialog";
import { RenameDialog } from "./RenameDialog";
import { serviceTabs } from "./tabs";

function TabNav({ project, service }: { project: string; service: string }) {
  const { t } = useTranslation("services");
  return (
    <nav aria-label={t("tabs.label")} className="-mb-px flex gap-5 overflow-x-auto [scrollbar-width:none]">
      {serviceTabs.map((tab) => (
        <Link
          key={tab.key}
          to={tab.to}
          params={{ project, service }}
          activeOptions={{ exact: tab.key === "overview", includeHash: false, includeSearch: false }}
          className="relative h-9 shrink-0 whitespace-nowrap text-sm leading-9 text-muted after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:origin-left after:scale-x-0 after:bg-highlight after:transition-transform after:duration-[160ms] after:ease-out hover:text-ink data-[status=active]:font-medium data-[status=active]:text-ink data-[status=active]:after:scale-x-100"
        >
          {t(`tabs.${tab.key}`)}
        </Link>
      ))}
    </nav>
  );
}

function ServiceToolbar({ detail }: { detail: ServiceDetail }) {
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

  return (
    <>
      <Button
        variant="primary"
        icon={<Rocket aria-hidden="true" className="size-4" />}
        pending={deploying}
        disabled={busy && !deploying}
        onClick={() => deploy()}
      >
        {t("toolbar.deploy")}
      </Button>
      <Tooltip content={stopped ? t("toolbar.start") : t("toolbar.stop")}>
        <Button
          size="icon"
          aria-label={stopped ? t("toolbar.start") : t("toolbar.stop")}
          disabled={busy || !deployed}
          onClick={stopped ? startService : stop}
        >
          {stopped ? (
            <Play aria-hidden="true" className="size-4" />
          ) : (
            <Square aria-hidden="true" className="size-4" />
          )}
        </Button>
      </Tooltip>
      <Tooltip content={t("toolbar.restart")}>
        <Button
          size="icon"
          aria-label={t("toolbar.restart")}
          disabled={busy || stopped || !deployed}
          onClick={restart}
        >
          <RotateCw aria-hidden="true" className="size-4" />
        </Button>
      </Tooltip>
      <LogsButton project={project} service={service} />
      <ConsoleButton project={project} service={service} running={detail.replicas.running > 0} />
      {detail.primaryUrl === null ? (
        <Button size="icon" aria-label={t("toolbar.open")} disabled>
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
          <DropdownMenuItem disabled={busy} onSelect={() => deploy({ force: true })}>
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
      />
    </>
  );
}

/** The frame of every service tab: identity, toolbar, readings and the tab strip. */
export function ServiceLayout() {
  const { t } = useTranslation(["services", "common"]);
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
          <div className="grid max-w-[520px] justify-items-start gap-3">
            <FormBanner>{errorMessage(error, t)}</FormBanner>
            <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
          </div>
        ) : (
          <Skeleton className="h-16" />
        )}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <StatusLamp
              status={lampForService(detail.status, detail.activeAction)}
              label={t(statusLabelKey(detail.status))}
            />
            <span className="font-mono">{service}</span>
            <Badge mono>{detail.type}</Badge>
            <Tooltip content={t("rename.open")}>
              <button
                type="button"
                aria-label={t("rename.open")}
                onClick={() => setRenaming(true)}
                className="flex size-7 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
              >
                <Pencil aria-hidden="true" className="size-3.5" />
              </button>
            </Tooltip>
          </span>
        }
        description={
          detail.activeAction !== null ? (
            t("activeAction", {
              label: actionLabel({ type: detail.activeAction.type, title: detail.activeAction.type }, t),
            })
          ) : (
            <span className="font-mono text-sm">
              {t(statusLabelKey(detail.status))} · {detail.replicas.running}/{detail.replicas.desired}
            </span>
          )
        }
        actions={<ServiceToolbar detail={detail} />}
      >
        <MetricsRow project={project} service={service} />
        <TabNav project={project} service={service} />
      </PageHeader>
      <Outlet />
      <RenameDialog project={project} service={service} open={renaming} onOpenChange={setRenaming} />
    </>
  );
}
