import { type BoxDetail, type BoxProcess, type BoxProcessStatus, boxProcess } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, schemaErrors, useForm } from "../../../../lib/forms";
import {
  Button,
  ConfirmDialog,
  countStates,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormBanner,
  HealthSummary,
  Input,
  Lamp,
  MonoValue,
  SectionIntro,
  Skeleton,
  Switch,
  Table,
  TBody,
  TD,
  Textarea,
  TH,
  THead,
  TR,
  toast,
} from "../../../../ui";
import { boxApi, boxProcessesQuery, boxQuery } from "../../../box/api";
import { useActionFollower } from "../../ActionFollower";
import { serviceKey, useServiceParams } from "../../api";
import { processVisualState } from "./state";

type Editing = { index: number | null; process: BoxProcess };

const blank: BoxProcess = { name: "", command: "", directory: ".", enabled: true };

function ProcessDialog({
  editing,
  existing,
  onClose,
  onSave,
}: {
  editing: Editing | null;
  existing: readonly BoxProcess[];
  onClose: () => void;
  onSave: (next: BoxProcess, index: number | null) => Promise<void>;
}) {
  const { t } = useTranslation(["service-box-processes", "common"]);
  const form = useForm<BoxProcess & Record<string, unknown>>({
    t,
    initialValues: editing?.process ?? blank,
    validate: (values) => {
      const errors = schemaErrors<"name" | "command" | "directory">(boxProcess, values, {
        name: t("errors.name"),
        command: t("errors.command"),
        directory: t("errors.directory"),
      });
      if (
        errors.name === undefined &&
        existing.some((process, index) => process.name === values.name && index !== editing?.index)
      ) {
        return { ...errors, name: t("errors.duplicate") };
      }
      return errors;
    },
    onSubmit: async (values) => {
      await onSave(values, editing?.index ?? null);
      onClose();
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts from what it was opened on
  useEffect(() => {
    if (editing !== null) {
      form.reset(editing.process);
    }
  }, [editing]);

  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      title={editing?.index === null ? t("dialog.add") : t("dialog.edit")}
      description={t("dialog.description")}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("fields.name")} hint={t("fields.nameHint")} error={form.errors.name}>
          <Input {...form.field("name")} mono autoComplete="off" spellCheck={false} />
        </Field>
        <Field label={t("fields.command")} hint={t("fields.commandHint")} error={form.errors.command}>
          <Textarea {...form.field("command")} mono rows={3} spellCheck={false} />
        </Field>
        <Field label={t("fields.directory")} hint={t("fields.directoryHint")} error={form.errors.directory}>
          <Input {...form.field("directory")} mono autoComplete="off" spellCheck={false} />
        </Field>
        <Switch
          label={t("fields.enabled")}
          hint={t("fields.enabledHint")}
          checked={form.values.enabled}
          onCheckedChange={(checked) => form.set("enabled", checked)}
        />
      </div>
    </Dialog>
  );
}

function StatusCell({ status }: { status: BoxProcessStatus }) {
  const { t, i18n } = useTranslation("service-box-processes");
  const since = status.since === null ? null : new Date(status.since).toLocaleString(i18n.language);
  return (
    <Lamp
      state={processVisualState(status.state)}
      showLabel
      label={since === null ? t(`state.${status.state}`) : `${t(`state.${status.state}`)} · ${since}`}
    />
  );
}

function ProcessRows({
  detail,
  statuses,
  project,
  service,
  onEdit,
  onDelete,
}: {
  detail: BoxDetail;
  statuses: readonly BoxProcessStatus[];
  project: string;
  service: string;
  onEdit: (index: number) => void;
  onDelete: (index: number) => void;
}) {
  const { t } = useTranslation(["service-box-processes", "common"]);
  const follow = useActionFollower();
  const queryClient = useQueryClient();
  const [restarting, setRestarting] = useState<string | null>(null);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: boxProcessesQuery(project, service).queryKey });

  const restart = async (name: string) => {
    setRestarting(name);
    try {
      const action = await boxApi.restartProcess(project, service, name);
      follow(action.id, {
        success: () => {
          toast.success(t("restarted", { name }));
          void refresh();
        },
        failure: (ended) => toast.error(t("restartFailed", { name }), ended.error ?? undefined),
      });
    } catch (error) {
      toast.error(t("restartFailed", { name }), errorMessage(error, t));
    } finally {
      setRestarting(null);
    }
  };

  return (
    <Table>
      <THead>
        <TR>
          <TH>{t("columns.state")}</TH>
          <TH>{t("columns.name")}</TH>
          <TH>{t("columns.command")}</TH>
          <TH numeric>{t("columns.restarts")}</TH>
          <TH numeric>{t("columns.exit")}</TH>
          <TH className="text-right">{t("columns.actions")}</TH>
        </TR>
      </THead>
      <TBody>
        {statuses.map((status) => {
          const index = detail.processes.findIndex((process) => process.name === status.name);
          const process = detail.processes[index];
          const restartable = status.state !== "disabled";
          return (
            <TR key={status.name}>
              <TD>
                <StatusCell status={status} />
              </TD>
              <TD mono>
                {status.name}
                {status.system && <span className="ml-2 font-sans text-sm text-muted">{t("system")}</span>}
              </TD>
              <TD>
                {process === undefined ? (
                  <span className="text-muted">{t("startedByModule")}</span>
                ) : (
                  <span className="block max-w-[28rem] truncate font-mono text-sm" title={process.command}>
                    {process.command}
                  </span>
                )}
              </TD>
              <TD mono numeric>
                {status.restarts}
              </TD>
              <TD mono numeric>
                {status.lastExit ?? "--"}
              </TD>
              <TD className="text-right">
                <span className="inline-flex justify-end gap-1">
                  <Button
                    size="icon-sm"
                    aria-label={t("restart", { name: status.name })}
                    tooltip={t("restart", { name: status.name })}
                    pending={restarting === status.name}
                    disabledReason={restartable ? undefined : t("notRunning")}
                    onClick={() => restart(status.name)}
                  >
                    <RotateCw aria-hidden="true" className="size-3.5" />
                  </Button>
                  {process !== undefined && (
                    <>
                      <Button
                        size="icon-sm"
                        aria-label={t("edit", { name: status.name })}
                        tooltip={t("edit", { name: status.name })}
                        onClick={() => onEdit(index)}
                      >
                        <Pencil aria-hidden="true" className="size-3.5" />
                      </Button>
                      <Button
                        size="icon-sm"
                        aria-label={t("remove", { name: status.name })}
                        tooltip={t("remove", { name: status.name })}
                        onClick={() => onDelete(index)}
                      >
                        <Trash2 aria-hidden="true" className="size-3.5" />
                      </Button>
                    </>
                  )}
                </span>
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}

/** Each process with a lamp, what it is doing and how often it has come back. */
export function BoxProcessesTab() {
  const { t } = useTranslation(["service-box-processes", "common"]);
  const { project, service } = useServiceParams();
  const queryClient = useQueryClient();
  const box = useQuery(boxQuery(project, service));
  const status = useQuery({ ...boxProcessesQuery(project, service), refetchInterval: 3000 });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });

  const counts = useMemo(
    () => countStates((status.data?.processes ?? []).map((process) => processVisualState(process.state))),
    [status.data],
  );

  if (box.isPending) {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (box.isError) {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <ErrorState message={errorMessage(box.error, t)} onRetry={() => box.refetch()} />
      </div>
    );
  }
  const detail = box.data;

  const save = async (processes: BoxProcess[]) => {
    await boxApi.saveProcesses(project, service, { processes });
    await refresh();
    toast.success(t("saved"));
  };

  const add = (
    <Button
      variant="primary"
      icon={<Plus aria-hidden="true" className="size-4" />}
      onClick={() => setEditing({ index: null, process: blank })}
    >
      {t("add")}
    </Button>
  );

  const statuses = status.data?.processes ?? [];
  const body = () => {
    if (status.isPending) {
      return <Skeleton className="h-16" />;
    }
    if (status.isError) {
      return <ErrorState message={errorMessage(status.error, t)} onRetry={() => status.refetch()} />;
    }
    if (statuses.length === 0) {
      return (
        <EmptyState
          illustration="no-services"
          title={t("emptyTitle")}
          description={t("emptyBody")}
          action={add}
        />
      );
    }
    return (
      <ProcessRows
        detail={detail}
        statuses={statuses}
        project={project}
        service={service}
        onEdit={(index) => {
          const process = detail.processes[index];
          if (process !== undefined) {
            setEditing({ index, process });
          }
        }}
        onDelete={setDeleting}
      />
    );
  };

  return (
    <div className="grid max-w-[1130px] gap-4 px-4 py-6 md:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionIntro pictogram="activity" title={t("title")} description={t("description")} />
        {statuses.length > 0 && add}
      </div>
      {statuses.length > 0 && <HealthSummary variant="row" counts={counts} label={t("title")} />}
      {status.data?.reachable === false && statuses.length > 0 && <FormBanner>{t("unreachable")}</FormBanner>}
      {body()}
      <p className="text-sm text-muted">
        {t("identity", {
          user: detail.runtime.user,
          uid: detail.runtime.uid,
          path: detail.runtime.workspacePath,
        })}
      </p>
      <ProcessDialog
        editing={editing}
        existing={detail.processes}
        onClose={() => setEditing(null)}
        onSave={async (next, index) =>
          save(
            index === null
              ? [...detail.processes, next]
              : detail.processes.map((process, position) => (position === index ? next : process)),
          )
        }
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
          }
        }}
        title={t("deleteTitle")}
        description={<MonoValue value={detail.processes[deleting ?? 0]?.name ?? ""} />}
        confirmLabel={t("deleteConfirm")}
        onConfirm={async () => {
          await save(detail.processes.filter((_, position) => position !== deleting));
          setDeleting(null);
        }}
      >
        <p>{t("deleteBody")}</p>
      </ConfirmDialog>
    </div>
  );
}
