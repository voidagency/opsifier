import {
  type ActionEntry,
  type PanelUpdateStatus,
  panelRollbackConfirm,
  panelUpdateConfirm,
} from "@opsifier/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, LoaderCircle, RefreshCw } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { systemInfoQuery } from "../../app/shell/systemInfo";
import { errorMessage } from "../../lib/forms";
import { Button, ConfirmDialog, Dialog, Lamp, Markdown, MonoValue, Tooltip, toast } from "../../ui";
import { useCurrentUser } from "../auth/session";
import {
  applyUpdate,
  checkForUpdate,
  getAction,
  rollbackUpdate,
  updateStatusKey,
  updateStatusQuery,
} from "./api";

/** How often an update under way is looked at. Fast enough to feel like it is being followed. */
const FOLLOW_MS = 3000;

function useDateTime(): (iso: string) => string {
  const { i18n } = useTranslation();
  const format = new Intl.DateTimeFormat(i18n.language, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return (iso) => format.format(new Date(iso));
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-2 text-sm last:border-b-0">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

function LastUpdate({ status }: { status: PanelUpdateStatus }) {
  const { t } = useTranslation("panel-update");
  const formatDate = useDateTime();
  const { last } = status;
  if (last === null) {
    return null;
  }
  return (
    <DetailRow label={t("details.last")}>
      <span title={last.message ?? undefined}>
        {t(`outcome.${last.kind}.${last.result}`, { from: last.fromVersion, to: last.toVersion })}
        {last.finishedAt && ` · ${formatDate(last.finishedAt)}`}
      </span>
    </DetailRow>
  );
}

interface DetailsDialogProps {
  status: PanelUpdateStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRollback: () => void;
}

/** The versions behind the label in the top bar, and the way back. */
function DetailsDialog({ status, open, onOpenChange, onRollback }: DetailsDialogProps) {
  const { t } = useTranslation("panel-update");
  const formatDate = useDateTime();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("details.title")}>
      <dl>
        <DetailRow label={t("details.active")}>
          <MonoValue value={status.activeVersion} />
        </DetailRow>
        <DetailRow label={t("details.deployed")}>
          {status.deployedImage === null ? (
            t("details.unmanaged")
          ) : (
            <MonoValue value={status.deployedImage} truncate />
          )}
        </DetailRow>
        <DetailRow label={t("details.checked")}>
          {status.checkedAt === null ? t("details.neverChecked") : formatDate(status.checkedAt)}
        </DetailRow>
        <LastUpdate status={status} />
      </dl>
      {status.checkError !== null && <p className="mt-3 text-sm text-bad">{status.checkError}</p>}
      {status.rollback !== null && (
        <div className="mt-4 flex items-center justify-between gap-4">
          <p className="text-sm text-muted">
            {t(status.rollback.restoresData ? "rollback.explainData" : "rollback.explain", {
              version: status.rollback.version,
              at: formatDate(status.rollback.savedAt),
            })}
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
              onRollback();
            }}
          >
            {t("rollback.open", { version: status.rollback.version })}
          </Button>
        </div>
      )}
    </Dialog>
  );
}

/** Shows what is about to change before anything does. */
function UpdateDialog({
  status,
  open,
  onOpenChange,
  onStarted,
}: {
  status: PanelUpdateStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (action: ActionEntry, target: string) => void;
}) {
  const { t } = useTranslation("panel-update");
  const release = status.latest;
  if (release === null) {
    return null;
  }
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="primary"
      title={t("update.title", { version: release.version })}
      description={t("update.description", { current: status.activeVersion })}
      confirmLabel={t("update.confirm")}
      confirmText={panelUpdateConfirm}
      onConfirm={async () => {
        onStarted(
          await applyUpdate({ version: release.version, confirm: panelUpdateConfirm }),
          release.version,
        );
      }}
    >
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: it scrolls, so the keyboard has to reach it */}
      <div tabIndex={0} className="max-h-[40dvh] overflow-y-auto rounded-sm border bg-raised p-3 text-sm">
        {release.notes.trim() === "" ? (
          <p className="text-muted">{t("update.noNotes")}</p>
        ) : (
          <Markdown text={release.notes} />
        )}
      </div>
      {release.migrations.length > 0 && (
        <div className="mt-3">
          <h3 className="eyebrow">{t("update.migrations")}</h3>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {release.migrations.map((migration) => (
              <li key={migration}>{migration}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 text-sm text-muted">{t("update.safety")}</p>
    </ConfirmDialog>
  );
}

function RollbackDialog({
  status,
  open,
  onOpenChange,
  onStarted,
}: {
  status: PanelUpdateStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (action: ActionEntry, target: string) => void;
}) {
  const { t } = useTranslation("panel-update");
  const formatDate = useDateTime();
  if (status.rollback === null) {
    return null;
  }
  const { version, restoresData, savedAt } = status.rollback;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("rollback.title", { version })}
      description={t(restoresData ? "rollback.descriptionData" : "rollback.description", {
        at: formatDate(savedAt),
      })}
      confirmLabel={t("rollback.confirm")}
      confirmText={panelRollbackConfirm}
      onConfirm={async () => {
        onStarted(await rollbackUpdate({ confirm: panelRollbackConfirm }), version);
      }}
    />
  );
}

interface Following {
  actionId: string | null;
  target: string;
  /** What the status said when this started: the update is over once it says something else. */
  fromVersion: string;
  fromFinishedAt: string | null;
}

/** Stays up from the moment an update is requested until the new version answers. */
function RestartingDialog({
  following,
  status,
}: {
  following: Following;
  status: PanelUpdateStatus | undefined;
}) {
  const { t } = useTranslation("panel-update");
  const verifying = status?.inProgress?.state === "verifying";
  return (
    <Dialog open onOpenChange={() => {}} title={t("restart.title", { version: following.target })}>
      <p className="flex items-center gap-2 text-sm">
        <Lamp state="progress" label={t("restart.progress")} />
        {t(verifying ? "restart.verifying" : "restart.applying", { version: following.target })}
      </p>
      <p className="mt-2 text-sm text-muted">{t("restart.explain")}</p>
    </Dialog>
  );
}

/**
 * The panel's version and everything to do with changing it. The label is on every page; the rest
 * only ever appears for an administrator, because only one can act on it.
 */
export function PanelVersion() {
  const { t } = useTranslation("panel-update");
  const { t: tCommon } = useTranslation();
  const user = useCurrentUser();
  const isAdmin = user?.role === "admin";
  const client = useQueryClient();
  const { data: system } = useQuery(systemInfoQuery);
  const [following, setFollowing] = useState<Following | null>(null);
  const [dialog, setDialog] = useState<"update" | "rollback" | "details" | null>(null);
  const loadedVersion = useRef<string | null>(null);

  const { data: status } = useQuery({
    ...updateStatusQuery,
    enabled: isAdmin,
    refetchInterval: (query) =>
      following !== null || query.state.data?.inProgress != null ? FOLLOW_MS : false,
    refetchIntervalInBackground: true,
  });

  // A pull that fails never reaches the point where the status changes: only the Action knows.
  const { data: action } = useQuery({
    queryKey: ["system", "update", "action", following?.actionId],
    queryFn: ({ signal }) => getAction(following?.actionId as string, signal),
    enabled: following !== null && following.actionId !== null,
    refetchInterval: FOLLOW_MS,
    refetchIntervalInBackground: true,
    retry: false,
  });

  useEffect(() => {
    if (system !== undefined) {
      loadedVersion.current ??= system.version;
    }
  }, [system]);

  const startFollowing = (startedAction: ActionEntry | null, target: string) => {
    setDialog(null);
    setFollowing({
      actionId: startedAction?.id ?? status?.inProgress?.actionId ?? null,
      target,
      fromVersion: status?.activeVersion ?? system?.version ?? "",
      fromFinishedAt: status?.last?.finishedAt ?? null,
    });
  };

  // An update someone else started, or that was already under way when this page loaded.
  useEffect(() => {
    if (status?.inProgress != null && following === null) {
      setFollowing({
        actionId: status.inProgress.actionId,
        target: status.inProgress.toVersion,
        fromVersion: status.activeVersion,
        fromFinishedAt: status.last?.finishedAt ?? null,
      });
    }
  }, [status, following]);

  // While an update runs the server goes away for a moment, so only the outcome is reported.
  useEffect(() => {
    if (status === undefined || following === null) {
      return;
    }
    const finishedAt = status.last?.finishedAt ?? null;
    const ended =
      action?.status === "failed" || action?.status === "cancelled" || action?.status === "uncertain";
    if (action?.id === following.actionId && ended) {
      // Failed before handing over: the panel never restarted, so there is no outcome to wait for.
      if (status.inProgress === null && finishedAt === following.fromFinishedAt) {
        setFollowing(null);
        toast.error(t("result.notStarted"), action.error);
        return;
      }
    }
    const moved =
      status.inProgress === null &&
      (status.activeVersion !== following.fromVersion || finishedAt !== following.fromFinishedAt);
    if (!moved) {
      return;
    }
    setFollowing(null);
    const { last } = status;
    if (last === null || last.result === "succeeded") {
      toast.success(t("result.success", { version: status.activeVersion }));
    } else {
      toast.error(
        t("result.failure", { version: last.toVersion, active: status.activeVersion }),
        last.message,
      );
    }
    void client.invalidateQueries({ queryKey: ["system"] });
    if (status.activeVersion !== loadedVersion.current) {
      window.location.reload();
    }
  }, [status, following, action, t, client]);

  const check = useMutation({
    mutationFn: checkForUpdate,
    onMutate: () => toast({ title: t("check.checking") }),
    onSuccess: (result) => {
      client.setQueryData(updateStatusKey, result);
      if (result.checkError !== null) {
        toast.error(t("check.failed"), result.checkError);
      } else if (result.updateAvailable) {
        toast.success(t("check.available", { version: result.latest?.version }));
      } else {
        toast.success(t("check.none"));
      }
    },
    onError: (error) => toast.error(t("check.failed"), errorMessage(error, tCommon)),
  });

  if (system === undefined) {
    return null;
  }

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {isAdmin && status !== undefined ? (
        <Tooltip content={t("details.open")}>
          <button
            type="button"
            onClick={() => setDialog("details")}
            className="hidden rounded-sm px-1 font-mono text-xs text-muted hover:text-ink sm:block"
          >
            v{status.activeVersion}
          </button>
        </Tooltip>
      ) : (
        <span className="hidden px-1 font-mono text-xs text-muted sm:block">v{system.version}</span>
      )}

      {isAdmin && status?.checksEnabled === true && (
        <Tooltip content={t("check.action")}>
          <button
            type="button"
            aria-label={t("check.action")}
            disabled={check.isPending || status === undefined}
            onClick={() => check.mutate()}
            className="hidden size-8 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink disabled:opacity-50 min-[100rem]:flex"
          >
            {check.isPending ? (
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <RefreshCw aria-hidden="true" className="size-4" />
            )}
          </button>
        </Tooltip>
      )}

      {status?.updateAvailable === true &&
        status.managed &&
        status.inProgress === null &&
        following === null && (
          <button
            type="button"
            onClick={() => setDialog("update")}
            className="ml-1 inline-flex h-7 items-center gap-1 rounded-sm bg-accent px-2 text-xs font-medium text-on-accent"
          >
            <ArrowUpCircle aria-hidden="true" className="size-4" />
            {t("update.action", { version: status.latest?.version })}
          </button>
        )}

      {status !== undefined && (
        <>
          <DetailsDialog
            status={status}
            open={dialog === "details"}
            onOpenChange={(open) => setDialog(open ? "details" : null)}
            onRollback={() => setDialog("rollback")}
          />
          <UpdateDialog
            status={status}
            open={dialog === "update"}
            onOpenChange={(open) => setDialog(open ? "update" : null)}
            onStarted={startFollowing}
          />
          <RollbackDialog
            status={status}
            open={dialog === "rollback"}
            onOpenChange={(open) => setDialog(open ? "rollback" : null)}
            onStarted={startFollowing}
          />
        </>
      )}
      {following !== null && <RestartingDialog following={following} status={status} />}
    </div>
  );
}
