import type { ActionEntry, BackupConfigEntry, BackupEntry, RestoreEntry } from "@opsifier/contract";
import { actionsTopic, presetOfCron } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Pencil, Play, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, formatDateTime, formatRelativeTime } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import { useTopic } from "../../lib/realtime";
import {
  Button,
  buttonClass,
  ConfirmDialog,
  countStates,
  EmptyState,
  ErrorState,
  HealthSummary,
  Lamp,
  MonoValue,
  Pictogram,
  type PictogramName,
  SectionIntro,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Tooltip,
  TR,
  toast,
  type VisualState,
  visualStates,
} from "../../ui";
import { ActionLogDialog } from "../activity/ActionLogDialog";
import { actionDetailQuery } from "../activity/api";
import { useActionFollower } from "../services/ActionFollower";
import { backupDownloadUrl, backupsApi, backupsKey, backupsQuery } from "./api";
import { ConfigDialog } from "./ConfigDialog";
import { RestoreBackupDialog, RestoreFromPathDialog } from "./RestoreDialogs";
import { RunDialog } from "./RunDialog";
import { fileNameOf, type HistoryItem, historyItems, stateOfConfig, stateOfHistoryItem } from "./state";

export interface BackupsPanelProps {
  project: string;
  service: string;
  scope: "database" | "volume";
}

type Dialogs =
  | { kind: "create" }
  | { kind: "edit"; config: BackupConfigEntry }
  | { kind: "run"; config: BackupConfigEntry }
  | { kind: "delete-config"; config: BackupConfigEntry }
  | { kind: "restore-path" }
  | { kind: "restore-backup"; backup: BackupEntry }
  | { kind: "delete-backup"; backup: BackupEntry }
  | { kind: "resolve"; restore: RestoreEntry }
  | { kind: "discard"; restore: RestoreEntry };

const kindPictogram: Record<"database" | "volume", PictogramName> = { database: "backup", volume: "volume" };

/** Everything about one service's backups: what is configured, what ran, and what it left behind. */
export function BackupsPanel({ project, service, scope }: BackupsPanelProps) {
  const { t, i18n } = useTranslation(["backups", "visual", "common"]);
  const queryClient = useQueryClient();
  const query = backupsQuery(project, service);
  const { data, isPending, error, refetch } = useQuery({ ...query, refetchInterval: 15_000 });
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [filter, setFilter] = useState<VisualState | null>(null);
  const [logAction, setLogAction] = useState<ActionEntry | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: backupsKey(project, service) });
  const close = () => setDialog(null);

  // A run finishing anywhere, including from a schedule, refreshes the list without a reload.
  useTopic<ActionEntry>(actionsTopic, (action) => {
    if (
      action.projectName === project &&
      action.serviceName === service &&
      action.type.startsWith("backup")
    ) {
      void refresh();
    }
  });

  const openLog = async (actionId: string | null) => {
    if (actionId === null) {
      return;
    }
    try {
      setLogAction(await queryClient.fetchQuery(actionDetailQuery(actionId)));
    } catch (failure) {
      toast.error(t("log.failed"), errorMessage(failure, t));
    }
  };

  if (isPending) {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (data === undefined) {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      </div>
    );
  }

  const history = historyItems(data.backups, data.restores);
  // A configuration with a problem comes first, as everywhere else: the order of the state language.
  const configs = [...data.configs].sort(
    (a, b) => visualStates.indexOf(stateOfConfig(a)) - visualStates.indexOf(stateOfConfig(b)),
  );
  const counts = countStates(history.map(stateOfHistoryItem));
  const shown = filter === null ? history : history.filter((item) => stateOfHistoryItem(item) === filter);
  const unresolved = data.restores.find((restore) => restore.unresolved);

  const nothing = data.configs.length === 0 && history.length === 0;

  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        icon={<RotateCcw aria-hidden="true" className="size-4" />}
        onClick={() => setDialog({ kind: "restore-path" })}
      >
        {t("actions.restore")}
      </Button>
      {!nothing && (
        <Button
          variant="primary"
          icon={<Pictogram name="schedule" size={16} />}
          onClick={() => setDialog({ kind: "create" })}
          disabledReason={
            scope === "volume" && data.volumes.length === 0 ? t("actions.noVolumes") : undefined
          }
        >
          {t("actions.create")}
        </Button>
      )}
    </div>
  );

  return (
    <section className="grid gap-6 px-4 py-6 md:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <SectionIntro
            pictogram={kindPictogram[scope]}
            title={t(`title.${scope}`)}
            description={t(`description.${scope}`)}
          />
          {history.length > 0 && (
            <HealthSummary
              variant="row"
              counts={counts}
              selected={filter}
              onSelect={setFilter}
              label={t("history.summary")}
            />
          )}
        </div>
        {headerActions}
      </div>

      {unresolved !== undefined && (
        <div className="grid gap-3 border-y py-4" data-unresolved="true">
          <div className="flex items-center gap-2.5">
            <Lamp state="failed" size="md" decorative />
            <h3 className="text-md font-medium">{t("unresolved.title")}</h3>
          </div>
          <p className="max-w-[72ch] text-sm text-muted">{unresolved.error ?? t("unresolved.description")}</p>
          <div className="flex flex-wrap gap-2">
            {unresolved.safetyBackupId !== null && (
              <Button
                onClick={() => {
                  const safety = data.backups.find((backup) => backup.id === unresolved.safetyBackupId);
                  if (safety !== undefined) {
                    setDialog({ kind: "restore-backup", backup: safety });
                  }
                }}
              >
                {t("unresolved.useSafety")}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setDialog({ kind: "resolve", restore: unresolved })}>
              {t("unresolved.markChecked")}
            </Button>
          </div>
        </div>
      )}

      {nothing ? (
        <EmptyState
          illustration="no-backups"
          title={t(`empty.title.${scope}`)}
          description={t(`empty.description.${scope}`)}
          action={
            scope === "volume" && data.volumes.length === 0 ? undefined : (
              <Button variant="primary" onClick={() => setDialog({ kind: "create" })}>
                {t("actions.create")}
              </Button>
            )
          }
        />
      ) : (
        <>
          {configs.length > 0 && (
            <ul className="border-y" aria-label={t("config.listLabel")}>
              {configs.map((config) => (
                <ConfigRow
                  key={config.id}
                  config={config}
                  timezone={data.timezone}
                  onRun={() => setDialog({ kind: "run", config })}
                  onEdit={() => setDialog({ kind: "edit", config })}
                  onDelete={() => setDialog({ kind: "delete-config", config })}
                />
              ))}
            </ul>
          )}

          {history.length > 0 && (
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-2">
                <Pictogram name="activity" className="text-muted" />
                <h3 className="text-md font-medium">{t("history.title")}</h3>
              </div>
              {shown.length === 0 ? (
                <p className="text-sm text-muted">{t("history.noneForFilter")}</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>{t("history.state")}</TH>
                      <TH>{t("history.run")}</TH>
                      <TH>{t("history.file")}</TH>
                      <TH numeric>{t("history.size")}</TH>
                      <TH>{t("history.destination")}</TH>
                      <TH>{t("history.when")}</TH>
                      <TH />
                    </TR>
                  </THead>
                  <TBody>
                    {shown.map((item) => (
                      <HistoryRow
                        key={`${item.entry}:${item.id}`}
                        item={item}
                        language={i18n.language}
                        downloadUrl={
                          item.entry === "backup" ? backupDownloadUrl(project, service, item.id) : undefined
                        }
                        onLog={() => openLog(item.actionId)}
                        onRestore={
                          item.entry === "backup"
                            ? () => setDialog({ kind: "restore-backup", backup: item })
                            : undefined
                        }
                        onDeleteBackup={
                          item.entry === "backup"
                            ? () => setDialog({ kind: "delete-backup", backup: item })
                            : undefined
                        }
                        onDiscard={
                          item.entry === "restore"
                            ? () => setDialog({ kind: "discard", restore: item })
                            : undefined
                        }
                      />
                    ))}
                  </TBody>
                </Table>
              )}
            </div>
          )}
        </>
      )}

      {(dialog?.kind === "create" || dialog?.kind === "edit") && (
        <ConfigDialog
          project={project}
          service={service}
          kind={scope}
          defaultDatabase={data.defaultDatabase}
          volumes={data.volumes}
          editing={dialog.kind === "edit" ? dialog.config : undefined}
          onClose={close}
          onSaved={refresh}
        />
      )}
      {dialog?.kind === "run" && (
        <RunDialog
          project={project}
          service={service}
          config={dialog.config}
          onClose={close}
          onStarted={refresh}
        />
      )}
      {dialog?.kind === "restore-path" && (
        <RestoreFromPathDialog
          project={project}
          service={service}
          scope={scope}
          defaultDatabase={data.defaultDatabase}
          onClose={close}
          onStarted={refresh}
        />
      )}
      {dialog?.kind === "restore-backup" && (
        <RestoreBackupDialog
          project={project}
          service={service}
          backup={dialog.backup}
          onClose={close}
          onStarted={refresh}
        />
      )}

      <ConfirmDialog
        open={dialog?.kind === "delete-config"}
        onOpenChange={(open) => !open && close()}
        title={t("config.deleteTitle")}
        description={t("config.deleteDescription")}
        confirmLabel={t("config.deleteConfirm")}
        onConfirm={async () => {
          if (dialog?.kind === "delete-config") {
            await backupsApi.deleteConfig(project, service, dialog.config.id);
            await refresh();
            toast.success(t("config.deleted"));
          }
        }}
      />
      <DeleteBackupDialog
        project={project}
        service={service}
        dialog={dialog}
        onClose={close}
        onDone={refresh}
      />
      <ResolveDialog project={project} service={service} dialog={dialog} onClose={close} onDone={refresh} />
      <DiscardCopyDialog
        project={project}
        service={service}
        dialog={dialog}
        onClose={close}
        onDone={refresh}
      />
      <ActionLogDialog action={logAction} onClose={() => setLogAction(null)} />
    </section>
  );
}

function ConfigRow({
  config,
  timezone,
  onRun,
  onEdit,
  onDelete,
}: {
  config: BackupConfigEntry;
  timezone: string;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation(["backups", "visual"]);
  const state = stateOfConfig(config);
  const subject =
    config.kind === "volume"
      ? config.volumeName
      : config.scope === "database"
        ? config.databaseName
        : t(`scope.${config.scope}`);
  const preset = presetOfCron(config.schedule);
  const scheduleLabel = preset === null ? config.schedule : t(`schedule.presets.${preset}`);
  const overdue = config.nextRunAt !== null && Date.parse(config.nextRunAt) <= Date.now();
  const nextLabel =
    config.nextRunAt === null
      ? t("config.notScheduled")
      : overdue
        ? t("config.dueNow")
        : t("config.nextRun", { when: formatRelativeTime(config.nextRunAt, i18n.language) });
  const nextDetail =
    config.nextRunAt === null
      ? undefined
      : t("config.nextRunDetail", {
          at: new Date(config.nextRunAt).toLocaleString(i18n.language),
          zone: timezone,
        });

  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b py-2.5 last:border-b-0">
      <Lamp state={state} size="md" label={t(`config.state.${state}`)} />
      <span className="grid min-w-0 gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <MonoValue value={subject ?? ""} truncate />
          <span aria-hidden="true" className="text-muted">
            →
          </span>
          {config.storageProviderName === null ? (
            <span className="text-bad">{t("config.noDestination")}</span>
          ) : (
            <MonoValue value={`${config.storageProviderName}: ${config.path}`} truncate />
          )}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
          <Tooltip content={config.schedule}>
            <span className="inline-flex items-center gap-1">
              <Pictogram name="schedule" size={16} />
              {config.enabled ? scheduleLabel : t("config.manualOnly")}
            </span>
          </Tooltip>
          {config.enabled && (
            <Tooltip content={nextDetail ?? nextLabel}>
              <span>{nextLabel}</span>
            </Tooltip>
          )}
          <span>
            {config.retention === null
              ? t("config.keepAll")
              : t("config.keepLast", { count: config.retention })}
          </span>
        </span>
      </span>
      <span className="flex items-center gap-1">
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("actions.run")}
          tooltip={t("actions.run")}
          onClick={onRun}
          disabledReason={config.destinationReady ? undefined : t("actions.destinationNotReady")}
        >
          <Play aria-hidden="true" className="size-4" />
        </Button>
        <Tooltip content={t("actions.edit")}>
          <Button size="icon" variant="ghost" aria-label={t("actions.edit")} onClick={onEdit}>
            <Pencil aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
        <Tooltip content={t("actions.delete")}>
          <Button size="icon" variant="ghost" aria-label={t("actions.delete")} onClick={onDelete}>
            <Trash2 aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
      </span>
    </li>
  );
}

/** What it is a copy of: one database or volume by name, or the words for a broader scope. */
function sourceOf(item: HistoryItem, t: (key: string) => string): string {
  if (item.scope === "instance" || item.scope === "accounts") {
    return t(`scope.${item.scope}`);
  }
  return item.databaseName ?? item.volumeName ?? "—";
}

/** The engine and version it came from, and the checksum in full, on demand. */
function sourceDetail(item: Extract<HistoryItem, { entry: "backup" }>): string | null {
  const engine = item.engine === null ? null : [item.engine, item.engineVersion].filter(Boolean).join(" ");
  const parts = [engine, item.sha256 === null ? null : `sha256 ${item.sha256}`].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : parts.join(" · ");
}

function HistoryRow({
  item,
  language,
  downloadUrl,
  onLog,
  onRestore,
  onDeleteBackup,
  onDiscard,
}: {
  item: HistoryItem;
  language: string;
  downloadUrl?: string;
  onLog: () => void;
  onRestore?: () => void;
  onDeleteBackup?: () => void;
  onDiscard?: () => void;
}) {
  const { t } = useTranslation(["backups", "visual"]);
  const state = stateOfHistoryItem(item);
  const isBackup = item.entry === "backup";
  const label = isBackup ? t(`history.origin.${item.origin}`) : t(`history.restore.${item.kind}`);
  const path = isBackup ? item.path : item.sourcePath;
  const detail = isBackup
    ? (item.name ?? (item.origin === "safety" ? t("history.safetyDetail") : undefined))
    : (item.databaseName ?? item.volumeName ?? undefined);
  const errorText = item.error ?? (isBackup ? item.cleanupError : null);

  return (
    <TR>
      <TD>
        <Lamp state={state} label={t(`history.status.${statusKey(item)}`)} showLabel still />
      </TD>
      <TD>
        <span className="grid gap-0.5">
          <span className="inline-flex items-center gap-1.5 text-sm">
            <Pictogram name={isBackup ? "backup" : "restore"} size={16} className="text-muted" />
            {label}
          </span>
          {detail !== undefined && detail !== null && <span className="text-xs text-muted">{detail}</span>}
        </span>
      </TD>
      <TD className="max-w-[330px]">
        <Tooltip content={path}>
          <span className="block truncate font-mono text-xs">{fileNameOf(path)}</span>
        </Tooltip>
        {isBackup && (
          <Tooltip content={sourceDetail(item) ?? item.path}>
            <span className="block truncate font-mono text-xs text-muted">
              {[
                sourceOf(item, t),
                item.format,
                item.sha256 === null ? null : `sha256 ${item.sha256.slice(0, 8)}`,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </span>
          </Tooltip>
        )}
        {errorText !== null && errorText !== undefined && (
          <Tooltip content={errorText}>
            <span className="block max-w-[330px] truncate text-xs text-bad">{errorText}</span>
          </Tooltip>
        )}
      </TD>
      <TD mono numeric>
        {isBackup && item.sizeBytes !== null ? (
          <Tooltip content={item.sha256 ? `sha256 ${item.sha256}` : formatBytes(item.sizeBytes)}>
            <span>{formatBytes(item.sizeBytes)}</span>
          </Tooltip>
        ) : (
          <span className="text-muted">—</span>
        )}
      </TD>
      <TD className="text-sm">{item.storageProviderName}</TD>
      <TD className="text-sm whitespace-nowrap">
        <Tooltip content={formatDateTime(item.at, language)}>
          <span>{formatRelativeTime(item.at, language)}</span>
        </Tooltip>
      </TD>
      <TD>
        <span className="flex items-center justify-end gap-1">
          {isBackup && item.restorable && downloadUrl !== undefined && (
            <Tooltip content={t("actions.download")}>
              <a
                className={buttonClass("ghost", "icon-sm")}
                href={downloadUrl}
                aria-label={t("actions.download")}
              >
                <Download aria-hidden="true" className="size-4" />
              </a>
            </Tooltip>
          )}
          {isBackup && item.restorable && (
            <Tooltip content={t("actions.restoreThis")}>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("actions.restoreThis")}
                onClick={onRestore}
              >
                <RotateCcw aria-hidden="true" className="size-4" />
              </Button>
            </Tooltip>
          )}
          {isBackup && item.status === "succeeded" && item.deletedAt === null && (
            <Tooltip content={t("actions.deleteBackup")}>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("actions.deleteBackup")}
                onClick={onDeleteBackup}
              >
                <Trash2 aria-hidden="true" className="size-4" />
              </Button>
            </Tooltip>
          )}
          {!isBackup && item.earlierCopy !== null && (
            <Tooltip content={t("actions.discardEarlier")}>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("actions.discardEarlier")}
                onClick={onDiscard}
              >
                <Trash2 aria-hidden="true" className="size-4" />
              </Button>
            </Tooltip>
          )}
          {item.actionId !== null && (
            <Tooltip content={t("actions.viewLog")}>
              <Button size="icon-sm" variant="ghost" aria-label={t("actions.viewLog")} onClick={onLog}>
                <FileText aria-hidden="true" className="size-4" />
              </Button>
            </Tooltip>
          )}
        </span>
      </TD>
    </TR>
  );
}

function statusKey(item: HistoryItem): string {
  if (item.entry === "backup" && item.deletedAt !== null) {
    return "removed";
  }
  if (item.entry === "restore" && item.unresolved) {
    return "unresolved";
  }
  return item.status;
}

function DeleteBackupDialog({
  project,
  service,
  dialog,
  onClose,
  onDone,
}: {
  project: string;
  service: string;
  dialog: Dialogs | null;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const { t } = useTranslation(["backups", "common"]);
  const follow = useActionFollower();
  const backup = dialog?.kind === "delete-backup" ? dialog.backup : null;
  return (
    <ConfirmDialog
      open={backup !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t("deleteBackup.title")}
      description={
        backup === null ? undefined : t("deleteBackup.description", { file: fileNameOf(backup.path) })
      }
      confirmLabel={t("deleteBackup.confirm")}
      onConfirm={async () => {
        if (backup !== null) {
          const action = await backupsApi.removeBackup(project, service, backup.id);
          follow(action.id, {
            success: () => toast.success(t("deleteBackup.done")),
            failure: (ended) => toast.error(t("deleteBackup.failed"), ended.error ?? undefined),
          });
          await onDone();
        }
      }}
    />
  );
}

function ResolveDialog({
  project,
  service,
  dialog,
  onClose,
  onDone,
}: {
  project: string;
  service: string;
  dialog: Dialogs | null;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const { t } = useTranslation(["backups", "common"]);
  const restore = dialog?.kind === "resolve" ? dialog.restore : null;
  const name = restore?.databaseName ?? restore?.volumeName ?? service;
  return (
    <ConfirmDialog
      open={restore !== null}
      onOpenChange={(open) => !open && onClose()}
      tone="primary"
      title={t("unresolved.resolveTitle")}
      description={t("unresolved.resolveDescription")}
      confirmLabel={t("unresolved.markChecked")}
      confirmText={name}
      onConfirm={async () => {
        if (restore !== null) {
          await backupsApi.resolveRestore(project, service, restore.id, { confirm: name });
          await onDone();
          toast.success(t("unresolved.resolved"));
        }
      }}
    />
  );
}

function DiscardCopyDialog({
  project,
  service,
  dialog,
  onClose,
  onDone,
}: {
  project: string;
  service: string;
  dialog: Dialogs | null;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const { t } = useTranslation(["backups", "common"]);
  const restore = dialog?.kind === "discard" ? dialog.restore : null;
  const name = restore?.volumeName ?? "";
  return (
    <ConfirmDialog
      open={restore !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t("discard.title")}
      description={t("discard.description", { folder: restore?.earlierCopy ?? "" })}
      confirmLabel={t("discard.confirm")}
      confirmText={name}
      onConfirm={async () => {
        if (restore !== null) {
          await backupsApi.discardEarlierCopy(project, service, restore.id, { confirm: name });
          await onDone();
          toast.success(t("discard.done"));
        }
      }}
    />
  );
}
