import type { ActionEntry, DatabaseEngine, ServiceDetail } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { MoreHorizontal, Play, Square } from "lucide-react";
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
  toast,
  useDocumentTitle,
} from "../../ui";
import { projectsKey } from "../projects/api";
import { ConsoleButton, LogsButton } from "../service-runtime/RuntimeButtons";
import { useActionFollower } from "../services/ActionFollower";
import { serviceKey, serviceQuery, servicesApi } from "../services/api";
import { NotesDialog } from "../services/NotesDialog";
import { RenameDialog } from "../services/RenameDialog";
import { ServiceHeader, TabPictogram, tabLinkClass } from "../services/ServiceHeader";
import { databaseQuery } from "./api";
import { databaseTabsFor } from "./tabs";

/** The project, engine and service the current route is about. */
export function useDatabaseParams(): { project: string; engine: DatabaseEngine; service: string } {
  return useParams({ strict: false }) as { project: string; engine: DatabaseEngine; service: string };
}

function DatabaseTabNav() {
  const { t } = useTranslation("databases");
  const { project, engine, service } = useDatabaseParams();
  return (
    <nav
      aria-label={t("tabs.label")}
      className="-mb-px flex gap-x-5 overflow-x-auto [scrollbar-width:none] md:flex-wrap md:overflow-visible"
    >
      {databaseTabsFor(engine).map((tab) => (
        <Link
          key={tab.key}
          to={tab.to}
          params={{ project, engine, service }}
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

  const busyReason = busy ? t("services:toolbar.busy") : undefined;

  return (
    <>
      <Button
        size="icon"
        aria-label={stopped ? t("toolbar.start") : t("toolbar.stop")}
        tooltip={stopped ? t("toolbar.start") : t("toolbar.stop")}
        disabledReason={detail.status === "undeployed" ? t("services:toolbar.notDeployed") : busyReason}
        onClick={() =>
          stopped
            ? start(() => servicesApi.start(project, service), t("toolbar.started"), t("toolbar.startFailed"))
            : start(() => servicesApi.stop(project, service), t("toolbar.stopped"), t("toolbar.stopFailed"))
        }
      >
        {stopped ? (
          <Play aria-hidden="true" className="size-4" />
        ) : (
          <Square aria-hidden="true" className="size-4" />
        )}
      </Button>
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
          <DropdownMenuItem disabledReason={busyReason} onSelect={redeploy}>
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
            {t("destroy.description")} <MonoValue value={service} copy copyLabel={t("destroy.copyName")} />
          </>
        }
        confirmLabel={t("destroy.confirm")}
        confirmText={service}
        onConfirm={destroy}
      >
        <RetentionSummary
          removed={t("destroy.removed")}
          kept={t("destroy.kept", { volume: database?.volume ?? "" })}
        />
      </ConfirmDialog>
    </>
  );
}

/** The frame of every database tab: identity, toolbar, readings and the tab strip. */
export function DatabaseLayout() {
  const { t } = useTranslation("databases");
  const { project, service } = useDatabaseParams();
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
        toolbar={<DatabaseToolbar detail={detail} />}
        tabs={<DatabaseTabNav />}
        onRename={() => setRenaming(true)}
      />
      <Outlet />
      <RenameDialog project={project} service={service} open={renaming} onOpenChange={setRenaming} />
    </>
  );
}
