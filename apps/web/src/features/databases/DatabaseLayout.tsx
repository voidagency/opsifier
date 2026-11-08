import type { ActionEntry, DatabaseEngine, ServiceDetail } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { MoreHorizontal, Pencil, Play, Square } from "lucide-react";
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
import { useActionFollower } from "../services/ActionFollower";
import { lampForService, serviceKey, serviceQuery, servicesApi, statusLabelKey } from "../services/api";
import { NotesDialog } from "../services/NotesDialog";
import { RenameDialog } from "../services/RenameDialog";
import { databaseQuery } from "./api";
import { databaseTabs } from "./tabs";

/** The project, engine and service the current route is about. */
export function useDatabaseParams(): { project: string; engine: DatabaseEngine; service: string } {
  return useParams({ strict: false }) as { project: string; engine: DatabaseEngine; service: string };
}

function DatabaseTabNav() {
  const { t } = useTranslation("databases");
  const { project, engine, service } = useDatabaseParams();
  return (
    <nav aria-label={t("tabs.label")} className="-mb-px flex gap-5 overflow-x-auto [scrollbar-width:none]">
      {databaseTabs.map((tab) => (
        <Link
          key={tab.key}
          to={tab.to}
          params={{ project, engine, service }}
          activeOptions={{ exact: tab.key === "overview", includeHash: false, includeSearch: false }}
          className="relative h-9 shrink-0 whitespace-nowrap text-sm leading-9 text-muted after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:origin-left after:scale-x-0 after:bg-highlight after:transition-transform after:duration-[160ms] after:ease-out hover:text-ink data-[status=active]:font-medium data-[status=active]:text-ink data-[status=active]:after:scale-x-100"
        >
          {t(`tabs.${tab.key}`)}
        </Link>
      ))}
    </nav>
  );
}

function DatabaseToolbar({ detail }: { detail: ServiceDetail }) {
  const { t } = useTranslation(["databases", "services", "common"]);
  const { project, service } = useDatabaseParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const follow = useActionFollower();
  const [notesOpen, setNotesOpen] = useState(false);
  const [destroyOpen, setDestroyOpen] = useState(false);
  const { data: database } = useQuery(databaseQuery(project, service));

  const refresh = () => queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
  const busy = detail.activeAction !== null;
  const stopped = detail.status === "stopped" || detail.stopped;
  const running = detail.status === "running";

  const start = async (run: () => Promise<ActionEntry>, success: string, failure: string) => {
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

  const redeploy = () =>
    start(() => servicesApi.deploy(project, service), t("toolbar.redeployed"), t("toolbar.redeployFailed"));

  const destroy = async () => {
    await servicesApi.destroy(project, service, service);
    await queryClient.invalidateQueries({ queryKey: projectsKey });
    toast({ title: t("destroy.started", { name: service }) });
    await navigate({ to: "/projects/$project", params: { project } });
  };

  return (
    <>
      <Tooltip content={stopped ? t("toolbar.start") : t("toolbar.stop")}>
        <Button
          size="icon"
          aria-label={stopped ? t("toolbar.start") : t("toolbar.stop")}
          disabled={busy || detail.status === "undeployed"}
          onClick={() =>
            stopped
              ? start(
                  () => servicesApi.start(project, service),
                  t("toolbar.started"),
                  t("toolbar.startFailed"),
                )
              : start(() => servicesApi.stop(project, service), t("toolbar.stopped"), t("toolbar.stopFailed"))
          }
        >
          {stopped ? (
            <Play aria-hidden="true" className="size-4" />
          ) : (
            <Square aria-hidden="true" className="size-4" />
          )}
        </Button>
      </Tooltip>
      <LogsButton project={project} service={service} />
      <ConsoleButton project={project} service={service} running={running} />
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("toolbar.more")}
          className="flex size-8 items-center justify-center rounded-sm border border-off hover:bg-wash data-[state=open]:bg-wash"
        >
          <MoreHorizontal aria-hidden="true" className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => setNotesOpen(true)}>{t("toolbar.notes")}</DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={redeploy}>
            {t("toolbar.redeploy")}
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
            {t("destroy.description", { volume: database?.volume ?? "" })}{" "}
            <MonoValue value={service} copy copyLabel={t("destroy.copyName")} />
          </>
        }
        confirmLabel={t("destroy.confirm")}
        confirmText={service}
        onConfirm={destroy}
      />
    </>
  );
}

/** The frame of every database tab: identity, toolbar, readings and the tab strip. */
export function DatabaseLayout() {
  const { t } = useTranslation(["databases", "services", "common"]);
  const { project, engine, service } = useDatabaseParams();
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
              label={t(`services:${statusLabelKey(detail.status)}`)}
            />
            <span className="font-mono">{service}</span>
            <Badge mono>{t(`databases:engines.${engine}`)}</Badge>
            <Tooltip content={t("services:rename.open")}>
              <button
                type="button"
                aria-label={t("services:rename.open")}
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
            t("services:activeAction", {
              label: actionLabel({ type: detail.activeAction.type, title: detail.activeAction.type }, t),
            })
          ) : (
            <span className="font-mono text-sm">
              {t(`services:${statusLabelKey(detail.status)}`)} · {detail.replicas.running}/
              {detail.replicas.desired}
            </span>
          )
        }
        actions={<DatabaseToolbar detail={detail} />}
      >
        <MetricsRow project={project} service={service} />
        <DatabaseTabNav />
      </PageHeader>
      <Outlet />
      <RenameDialog project={project} service={service} open={renaming} onOpenChange={setRenaming} />
    </>
  );
}
