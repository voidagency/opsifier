import type { ScriptEntry, ScriptRun, ScriptSpec } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Play, Plus, ScrollText, Square, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDuration, formatRelativeTime } from "../../../../lib/format";
import { errorMessage } from "../../../../lib/forms";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Lamp,
  Pictogram,
  SectionIntro,
  Skeleton,
  stateFromScriptRun,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Tooltip,
  TR,
  toast,
} from "../../../../ui";
import { useServiceParams } from "../../api";
import { scriptRunsQuery, scriptsApi, scriptsQuery } from "./api";
import { RunDialog, useRunNote } from "./RunDialog";
import { ScriptDialog } from "./ScriptDialog";

type Pending =
  | { kind: "create" }
  | { kind: "edit"; index: number; script: ScriptSpec }
  | { kind: "delete"; index: number; script: ScriptSpec };

const isActive = (run: Pick<ScriptRun, "status">) => run.status === "queued" || run.status === "running";

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** The moment of the next run in the zone the schedule is stated in, for the tooltip. */
function zonedTime(iso: string, timeZone: string, language: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short", timeZone }).format(
    new Date(iso),
  );
}

function ScheduleLine({ script }: { script: ScriptEntry }) {
  const { t, i18n } = useTranslation("service-scripts");
  const facts = [t("row.limit", { seconds: script.maxDurationSeconds })];
  if (script.runAfterDeploy) {
    facts.push(t("row.afterDeploy"));
  }
  if (script.schedule === null) {
    return <span className="text-xs text-muted">{facts.join(" · ")}</span>;
  }
  const { cron, timeZone } = script.schedule;
  return (
    <span className="text-xs text-muted">
      <span className="font-mono">{cron}</span>
      {" · "}
      <span className="font-mono">{timeZone}</span>
      {script.nextRunAt !== null && (
        <>
          {" · "}
          <Tooltip content={zonedTime(script.nextRunAt, timeZone, i18n.language)}>
            <button type="button" className="underline decoration-dotted underline-offset-2">
              {t("row.next", { when: formatRelativeTime(script.nextRunAt, i18n.language) })}
            </button>
          </Tooltip>
        </>
      )}
      {" · "}
      {facts.join(" · ")}
    </span>
  );
}

function RunsTable({
  runs,
  onView,
  onCancel,
  cancelling,
}: {
  runs: readonly ScriptRun[];
  onView: (id: string) => void;
  onCancel: (run: ScriptRun) => void;
  cancelling: string | null;
}) {
  const { t, i18n } = useTranslation("service-scripts");
  const noteOf = useRunNote();
  const now = useNow(runs.some(isActive));
  return (
    <Table>
      <THead>
        <TR>
          <TH>{t("columns.outcome")}</TH>
          <TH>{t("columns.script")}</TH>
          <TH>{t("columns.when")}</TH>
          <TH>{t("columns.duration")}</TH>
          <TH>{t("columns.origin")}</TH>
          <TH numeric>{t("columns.exit")}</TH>
          <TH className="text-right">{t("columns.actions")}</TH>
        </TR>
      </THead>
      <TBody>
        {runs.map((run) => (
          <TR key={run.id}>
            <TD>
              <Tooltip content={noteOf(run) ?? t(`status.${run.status}`)}>
                <button type="button" className="inline-flex" aria-label={t(`status.${run.status}`)}>
                  <Lamp state={stateFromScriptRun(run.status)} label={t(`status.${run.status}`)} showLabel />
                </button>
              </Tooltip>
            </TD>
            <TD className="max-w-[12rem] truncate">{run.scriptName}</TD>
            <TD>{formatRelativeTime(run.createdAt, i18n.language, now)}</TD>
            <TD mono>{formatDuration(run.startedAt, run.finishedAt, now)}</TD>
            <TD>
              <Tooltip content={run.actorEmail ?? t(`origin.${run.origin}`)}>
                <span>{t(`origin.${run.origin}`)}</span>
              </Tooltip>
            </TD>
            <TD mono numeric>
              {run.exitCode ?? "--"}
            </TD>
            <TD className="text-right">
              <span className="inline-flex justify-end gap-1">
                {isActive(run) && run.origin !== "console" && (
                  <Tooltip content={t("cancelRun")}>
                    <Button
                      size="icon-sm"
                      aria-label={t("cancelRun")}
                      disabled={cancelling === run.id}
                      onClick={() => onCancel(run)}
                    >
                      <Square aria-hidden="true" className="size-3.5" />
                    </Button>
                  </Tooltip>
                )}
                <Tooltip content={t("viewRun")}>
                  <Button size="icon-sm" aria-label={t("viewRun")} onClick={() => onView(run.id)}>
                    <ScrollText aria-hidden="true" className="size-3.5" />
                  </Button>
                </Tooltip>
              </span>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export function ScriptsTab() {
  const { t } = useTranslation(["service-scripts", "common"]);
  const { project, service } = useServiceParams();
  const queryClient = useQueryClient();
  const query = scriptsQuery(project, service);
  const runsQuery = scriptRunsQuery(project, service);
  const { data, isPending, isError, error, refetch } = useQuery(query);
  const runs = useQuery(runsQuery);
  const [pending, setPending] = useState<Pending | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: query.queryKey }),
      queryClient.invalidateQueries({ queryKey: runsQuery.queryKey }),
    ]);
  const close = () => setPending(null);

  const run = async (name: string) => {
    setStarting(name);
    try {
      const started = await scriptsApi.run(project, service, name);
      await refresh();
      toast.success(t("started", { name }));
      setViewing(started.run.id);
    } catch (failure) {
      toast.error(errorMessage(failure, t));
    } finally {
      setStarting(null);
    }
  };

  const cancel = async (target: ScriptRun) => {
    setCancelling(target.id);
    try {
      await scriptsApi.cancel(project, service, target.id);
      await refresh();
    } catch (failure) {
      toast.error(errorMessage(failure, t));
    } finally {
      setCancelling(null);
    }
  };

  const add = (
    <Button
      variant="primary"
      icon={<Plus aria-hidden="true" className="size-4" />}
      onClick={() => setPending({ kind: "create" })}
    >
      {t("add")}
    </Button>
  );

  const scriptsBody = () => {
    if (isPending) {
      return <Skeleton className="h-6" />;
    }
    if (isError) {
      return <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />;
    }
    if (data.scripts.length === 0) {
      return (
        <EmptyState
          illustration="no-activity"
          title={t("empty.title")}
          description={t("empty.description")}
          action={add}
        />
      );
    }
    return (
      <div className="grid gap-4">
        <ul className="border-y">
          {data.scripts.map((script, index) => (
            <li
              key={script.name}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b py-2.5 last:border-b-0"
            >
              {script.lastRun === null ? (
                <Pictogram name="console" className="text-muted" />
              ) : (
                <Lamp
                  state={stateFromScriptRun(script.lastRun.status)}
                  label={t(`status.${script.lastRun.status}`)}
                />
              )}
              <span className="grid min-w-0 gap-0.5">
                <span className="truncate text-sm font-medium">{script.name}</span>
                <span className="truncate font-mono text-xs text-muted">
                  {script.script.split("\n", 1)[0] || t("emptyScript")}
                </span>
                <ScheduleLine script={script} />
              </span>
              <span className="flex items-center gap-1">
                <Tooltip content={t("run")}>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("runScript", { name: script.name })}
                    disabled={starting !== null || (script.lastRun !== null && isActive(script.lastRun))}
                    onClick={() => void run(script.name)}
                  >
                    <Play aria-hidden="true" className="size-4" />
                  </Button>
                </Tooltip>
                <Tooltip content={t("edit")}>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("edit")}
                    onClick={() => setPending({ kind: "edit", index, script })}
                  >
                    <Pencil aria-hidden="true" className="size-4" />
                  </Button>
                </Tooltip>
                <Tooltip content={t("delete")}>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("delete")}
                    onClick={() => setPending({ kind: "delete", index, script })}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </Button>
                </Tooltip>
              </span>
            </li>
          ))}
        </ul>
        <div>{add}</div>
      </div>
    );
  };

  const runsBody = () => {
    if (runs.isPending) {
      return <Skeleton className="h-6" />;
    }
    if (runs.isError) {
      return <ErrorState message={errorMessage(runs.error, t)} onRetry={() => runs.refetch()} />;
    }
    if (runs.data.items.length === 0) {
      return <p className="text-sm text-muted">{t("runs.empty")}</p>;
    }
    return (
      <RunsTable
        runs={runs.data.items}
        onView={setViewing}
        onCancel={(target) => void cancel(target)}
        cancelling={cancelling}
      />
    );
  };

  const hasScripts = data !== undefined && data.scripts.length > 0;

  return (
    <section className="grid gap-x-10 gap-y-8 px-4 py-6 md:px-6 lg:grid-cols-[minmax(0,260px)_minmax(0,620px)] lg:px-8">
      <SectionIntro pictogram="console" title={t("title")} description={t("description")} />
      {scriptsBody()}

      {hasScripts && (
        <>
          <SectionIntro pictogram="deployment" title={t("runs.title")} description={t("runs.description")} />
          {runsBody()}
        </>
      )}

      {(pending?.kind === "create" || pending?.kind === "edit") && (
        <ScriptDialog
          project={project}
          service={service}
          editing={pending.kind === "edit" ? pending : undefined}
          onClose={close}
          onSaved={refresh}
        />
      )}

      <RunDialog project={project} service={service} runId={viewing} onClose={() => setViewing(null)} />

      <ConfirmDialog
        open={pending?.kind === "delete"}
        onOpenChange={(open) => !open && close()}
        title={t("deleteDialog.title")}
        description={
          pending?.kind === "delete"
            ? t("deleteDialog.description", { name: pending.script.name })
            : undefined
        }
        confirmLabel={t("deleteDialog.confirm")}
        onConfirm={async () => {
          if (pending?.kind === "delete") {
            await scriptsApi.remove(project, service, pending.index);
            await refresh();
            toast.success(t("deleted"));
          }
        }}
      />
    </section>
  );
}
