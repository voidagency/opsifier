import { MAX_SCRIPT_OUTPUT_CHARS, type ScriptRun } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { formatDateTime, formatDuration } from "../../../../lib/format";
import { errorMessage } from "../../../../lib/forms";
import { Dialog, ErrorState, Lamp, MonoValue, Skeleton, stateFromScriptRun } from "../../../../ui";
import { scriptRunQuery } from "./api";

/** What a run's note says, in the interface's language. */
export function useRunNote() {
  const { t } = useTranslation("service-scripts");
  return (run: ScriptRun): string | null =>
    run.note === null
      ? null
      : t(`runNote.${run.note.code}`, {
          defaultValue: run.note.message,
          message: run.note.message,
          seconds: run.maxDurationSeconds,
          exitCode: run.exitCode,
        });
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** One run with everything that is known about it, and what it printed. */
export function RunDialog({
  project,
  service,
  runId,
  onClose,
}: {
  project: string;
  service: string;
  runId: string | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation(["service-scripts", "common"]);
  const noteOf = useRunNote();
  const { data, isPending, isError, error, refetch } = useQuery({
    ...scriptRunQuery(project, service, runId ?? ""),
    enabled: runId !== null,
  });

  const body = () => {
    if (isPending) {
      return <Skeleton className="h-6" />;
    }
    if (isError) {
      return <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />;
    }
    const run = data;
    const note = noteOf(run);
    return (
      <div className="grid gap-4">
        <Lamp state={stateFromScriptRun(run.status)} label={t(`status.${run.status}`)} showLabel />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <Fact label={t("run.origin")}>{t(`origin.${run.origin}`)}</Fact>
          <Fact label={t("run.actor")}>{run.actorEmail ?? "--"}</Fact>
          <Fact label={t("run.exitCode")}>
            <MonoValue value={run.exitCode === null ? "--" : String(run.exitCode)} />
          </Fact>
          <Fact label={t("run.started")}>
            {run.startedAt === null ? "--" : formatDateTime(run.startedAt, i18n.language)}
          </Fact>
          <Fact label={t("run.duration")}>
            <MonoValue value={formatDuration(run.startedAt, run.finishedAt)} />
          </Fact>
          <Fact label={t("run.limit")}>
            <MonoValue value={t("run.limitValue", { seconds: run.maxDurationSeconds })} />
          </Fact>
          {run.dueAt !== null && <Fact label={t("run.due")}>{formatDateTime(run.dueAt, i18n.language)}</Fact>}
          {run.task !== null && (
            <Fact label={t("run.task")}>
              <MonoValue value={run.task.slot === null ? run.task.id.slice(0, 12) : `#${run.task.slot}`} />
            </Fact>
          )}
        </dl>
        {note !== null && <p className="border-l-2 border-busy pl-3 text-sm">{note}</p>}
        <div className="grid gap-1.5">
          <h3 className="eyebrow">{t("run.output")}</h3>
          {run.output === "" ? (
            <p className="text-sm text-muted">{t("run.noOutput")}</p>
          ) : (
            <pre className="max-h-80 overflow-auto bg-raised p-3 font-mono text-xs whitespace-pre-wrap break-all">
              {run.output}
            </pre>
          )}
          {run.outputTruncated && (
            <p className="text-xs text-muted">{t("run.truncated", { count: MAX_SCRIPT_OUTPUT_CHARS })}</p>
          )}
          {!run.outputComplete && <p className="text-xs text-muted">{t("run.incomplete")}</p>}
        </div>
      </div>
    );
  };

  return (
    <Dialog
      open={runId !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      size="lg"
      title={data === undefined ? t("run.title") : t("run.titleOf", { name: data.scriptName })}
    >
      {runId !== null && body()}
    </Dialog>
  );
}
