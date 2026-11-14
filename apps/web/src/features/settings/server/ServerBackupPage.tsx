import type { ServerBackupSnapshots, ServerBackupState } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, formatDateTime } from "../../../lib/format";
import { errorMessage, useForm } from "../../../lib/forms";
import {
  Button,
  ErrorState,
  Field,
  FormBanner,
  Input,
  Lamp,
  Select,
  Skeleton,
  Switch,
  toast,
} from "../../../ui";
import { useCurrentUser } from "../../auth/session";
import { serverBackupApi, serverBackupQuery } from "./api";

interface Values {
  enabled: boolean;
  providerId: string;
  time: string;
  keepDaily: string;
  keepWeekly: string;
  keepMonthly: string;
  [key: string]: unknown;
}

const blank: Values = {
  enabled: false,
  providerId: "",
  time: "02:30",
  keepDaily: "14",
  keepWeekly: "8",
  keepMonthly: "6",
};

const fromState = (state: ServerBackupState): Values => ({
  enabled: state.enabled,
  providerId: state.providerId ?? state.destinations.find((destination) => destination.usable)?.id ?? "",
  time: state.time,
  keepDaily: String(state.keepDaily),
  keepWeekly: String(state.keepWeekly),
  keepMonthly: String(state.keepMonthly),
});

const KEEP = /^\d{1,3}$/;

const INSTALL_URL = "https://raw.githubusercontent.com/voidagency/opsifier/main/scripts/install.sh";

/** Single quotes for the shell: nothing inside them is interpreted. */
const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** What it takes to rebuild this server on another one, written out for this repository. */
function RestoreGuide({ repository }: { repository: string }) {
  const { t } = useTranslation("settings-server-backup");
  const s3 = repository.startsWith("s3:");
  const commands = [
    `export RESTIC_REPOSITORY=${quoted(repository)}`,
    "read -rs RESTIC_PASSWORD && export RESTIC_PASSWORD",
    ...(s3 ? ["export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_DEFAULT_REGION=…"] : []),
    `curl -fsSL ${INSTALL_URL} | bash -s -- --restore`,
  ];
  return (
    <section className="grid max-w-[850px] gap-3 border-t pt-5">
      <h3 className="font-medium">{t("restore.title")}</h3>
      <p className="max-w-[70ch] text-sm">{t("restore.intro")}</p>
      <div className="grid gap-1">
        <span className="text-sm text-muted">{t("restore.repository")}</span>
        <code className="break-all rounded bg-wash px-3 py-2 font-mono text-sm">{repository}</code>
      </div>
      <p className="text-sm">{t("restore.command")}</p>
      <pre className="overflow-x-auto rounded bg-wash px-3 py-2 font-mono text-xs">{commands.join("\n")}</pre>
      <p className="max-w-[70ch] text-sm text-muted">{t(s3 ? "restore.keys" : "restore.local")}</p>
      <p className="max-w-[70ch] text-sm text-muted">{t("restore.guide")}</p>
    </section>
  );
}

/** The recovery key, shown once when it is created, or again after the person proves who they are. */
function RecoveryKey({ value, onDone }: { value: string; onDone?: () => void }) {
  const { t } = useTranslation("settings-server-backup");
  return (
    <div className="grid gap-3 rounded-md border-l-2 border-busy bg-wash p-4">
      <h3 className="font-medium">{t("key.title")}</h3>
      <p className="text-sm">{t("key.created")}</p>
      <code className="break-all rounded bg-wash px-3 py-2 font-mono text-sm">{value}</code>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => toast.success(t("key.copied")));
          }}
        >
          {t("key.copy")}
        </Button>
        {onDone && (
          <Button type="button" variant="primary" onClick={onDone}>
            {t("key.kept")}
          </Button>
        )}
      </div>
    </div>
  );
}

function RevealKey() {
  const { t } = useTranslation(["settings-server-backup", "common"]);
  const user = useCurrentUser();
  const withCode = user?.twoFactorEnabled ?? false;
  const [shown, setShown] = useState<string | null>(null);
  const form = useForm<{ secret: string; [key: string]: unknown }>({
    t,
    initialValues: { secret: "" },
    onSubmit: async (values) => {
      const { recoveryKey } = await serverBackupApi.revealKey(
        withCode ? { code: values.secret.trim() } : { currentPassword: values.secret },
      );
      setShown(recoveryKey);
    },
  });
  if (shown !== null) {
    return <RecoveryKey value={shown} onDone={() => setShown(null)} />;
  }
  return (
    <form onSubmit={form.handleSubmit} noValidate className="grid max-w-md gap-3">
      {form.banner && <FormBanner>{form.banner}</FormBanner>}
      <Field
        label={withCode ? t("key.code") : t("key.password")}
        hint={t("key.revealHint")}
        error={form.errors.secret}
      >
        <Input
          {...form.field("secret")}
          type={withCode ? "text" : "password"}
          inputMode={withCode ? "numeric" : undefined}
          autoComplete={withCode ? "one-time-code" : "current-password"}
        />
      </Field>
      <div>
        <Button type="submit" variant="secondary" pending={form.pending}>
          {t("key.show")}
        </Button>
      </div>
    </form>
  );
}

function Snapshots() {
  const { t, i18n } = useTranslation("settings-server-backup");
  const [list, setList] = useState<ServerBackupSnapshots["snapshots"] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const load = async () => {
    setLoading(true);
    setFailure(null);
    try {
      setList((await serverBackupApi.snapshots()).snapshots);
    } catch (error) {
      setFailure(errorMessage(error, t));
    } finally {
      setLoading(false);
    }
  };
  if (list === null) {
    return (
      <div className="grid gap-2">
        {failure && <FormBanner>{failure}</FormBanner>}
        <div>
          <Button type="button" variant="secondary" pending={loading} onClick={() => void load()}>
            {t("snapshots.load")}
          </Button>
        </div>
      </div>
    );
  }
  if (list.length === 0) {
    return <p className="text-sm text-muted">{t("snapshots.empty")}</p>;
  }
  return (
    <table className="w-full max-w-[850px] text-sm">
      <thead>
        <tr className="text-left text-muted">
          <th className="py-1 font-normal">{t("snapshots.when")}</th>
          <th className="py-1 font-normal">{t("snapshots.host")}</th>
          <th className="py-1 font-normal">{t("snapshots.added")}</th>
          <th className="py-1 font-normal">{t("snapshots.total")}</th>
        </tr>
      </thead>
      <tbody>
        {list.map((snapshot) => (
          <tr key={snapshot.id} className="border-t">
            <td className="py-1.5 font-mono text-xs">{formatDateTime(snapshot.time, i18n.language)}</td>
            <td className="py-1.5">{snapshot.hostname}</td>
            <td className="py-1.5">
              {snapshot.addedBytes === null ? "–" : formatBytes(snapshot.addedBytes)}
            </td>
            <td className="py-1.5">
              {snapshot.totalBytes === null ? "–" : formatBytes(snapshot.totalBytes)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The whole server, backed up every day with restic to a destination the panel already knows:
 * where, when, for how long, how the last run went, and the recovery key that opens it all.
 */
export function ServerBackupPage() {
  const { t, i18n } = useTranslation(["settings-server-backup", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(serverBackupQuery);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const form = useForm<Values>({
    t,
    initialValues: blank,
    validate: (values) => {
      const errors: Partial<Record<keyof Values & string, string>> = {};
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.time)) {
        errors.time = t("timeHint");
      }
      for (const key of ["keepDaily", "keepWeekly", "keepMonthly"] as const) {
        if (!KEEP.test(values[key])) {
          errors[key] = t("common:validation.number", { defaultValue: "0–999" });
        }
      }
      return errors;
    },
    onSubmit: async (values) => {
      const saved = await serverBackupApi.save({
        enabled: values.enabled,
        providerId: values.providerId === "" ? null : values.providerId,
        time: values.time,
        keepDaily: Number(values.keepDaily),
        keepWeekly: Number(values.keepWeekly),
        keepMonthly: Number(values.keepMonthly),
      });
      if (saved.recoveryKey !== null) {
        setNewKey(saved.recoveryKey);
      }
      await queryClient.invalidateQueries({ queryKey: serverBackupQuery.queryKey });
      toast.success(t("saved"));
    },
  });
  const { reset } = form;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refill only when the stored settings arrive
  useEffect(() => {
    if (data !== undefined) {
      reset(fromState(data));
    }
  }, [data]);

  if (isPending) {
    return <Skeleton className="m-6 h-40" />;
  }
  if (isError) {
    return <ErrorState className="m-6" message={errorMessage(error, t)} onRetry={() => refetch()} />;
  }

  const when = (iso: string | null) => (iso === null ? "–" : formatDateTime(iso, i18n.language));
  const usable = data.destinations.filter((destination) => destination.usable);
  const chosen = data.destinations.find((destination) => destination.id === form.values.providerId);
  const run = data.lastRun;

  const runNow = async () => {
    setStarting(true);
    try {
      await serverBackupApi.run();
      toast.success(t("status.started"));
      await queryClient.invalidateQueries({ queryKey: serverBackupQuery.queryKey });
    } catch (failure) {
      toast.error(errorMessage(failure, t));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 px-4 py-6 md:px-6 lg:px-8">
      <div>
        <h2 className="text-md font-medium">{t("title")}</h2>
        <p className="mt-1 max-w-[60ch] text-sm text-muted">{t("description")}</p>
      </div>

      {data.restore !== null && (
        <section
          className={`grid max-w-[850px] gap-2 rounded-md border-l-2 bg-wash p-4 ${data.restore.status === "failed" ? "border-bad" : "border-accent"}`}
        >
          <div className="flex items-center gap-2">
            <Lamp
              state={
                data.restore.status === "running"
                  ? "progress"
                  : data.restore.status === "succeeded"
                    ? "running"
                    : "failed"
              }
            />
            <p className="text-sm">
              {t(`restore.${data.restore.status}`, {
                host: data.restore.hostname,
                when: when(data.restore.snapshotTime),
                finished: when(data.restore.finishedAt),
              })}
            </p>
          </div>
          {data.restore.problems.length > 0 && (
            <ul className="list-disc pl-5 text-sm">
              {data.restore.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {newKey !== null && <RecoveryKey value={newKey} onDone={() => setNewKey(null)} />}

      <form onSubmit={form.handleSubmit} noValidate className="grid max-w-[850px] gap-4 border-t pt-5">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Switch
          label={t("enabled")}
          hint={t("enabledHint")}
          checked={form.values.enabled}
          onCheckedChange={(checked) => form.set("enabled", checked)}
        />
        <Field label={t("destination")} hint={t("destinationHint")} error={form.errors.providerId}>
          <Select
            value={form.values.providerId}
            onValueChange={(value) => form.set("providerId", value)}
            placeholder={usable.length === 0 ? t("destinationNone") : undefined}
            options={data.destinations.map((destination) => ({
              value: destination.id,
              label: destination.usable ? destination.name : t("unsupported", { name: destination.name }),
              disabled: !destination.usable,
            }))}
          />
        </Field>
        {chosen?.kind === "local" && <p className="text-sm text-busy">{t("sameDisk")}</p>}
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label={t("time")} hint={t("timeHint")} error={form.errors.time}>
            <Input {...form.field("time")} mono />
          </Field>
          <Field label={t("keepDaily")} hint={t("keepDailyHint")} error={form.errors.keepDaily}>
            <Input {...form.field("keepDaily")} inputMode="numeric" mono />
          </Field>
          <Field label={t("keepWeekly")} hint={t("keepWeeklyHint")} error={form.errors.keepWeekly}>
            <Input {...form.field("keepWeekly")} inputMode="numeric" mono />
          </Field>
          <Field label={t("keepMonthly")} hint={t("keepMonthlyHint")} error={form.errors.keepMonthly}>
            <Input {...form.field("keepMonthly")} inputMode="numeric" mono />
          </Field>
        </div>
        <div>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("save")}
          </Button>
        </div>
      </form>

      <section className="grid max-w-[850px] gap-3 border-t pt-5">
        <div className="flex items-center gap-2">
          <Lamp
            state={
              run === null
                ? "stopped"
                : run.status === "succeeded"
                  ? "running"
                  : run.status === "running"
                    ? "progress"
                    : "failed"
            }
          />
          <h3 className="font-medium">{t("status.title")}</h3>
        </div>
        <p className="text-sm">
          {run === null
            ? t("status.never")
            : run.status === "running"
              ? t("status.running", { when: when(run.startedAt) })
              : run.status === "succeeded"
                ? t("status.succeeded", {
                    when: when(run.finishedAt),
                    processed: run.processedBytes === null ? "–" : formatBytes(run.processedBytes),
                    added: run.addedBytes === null ? "–" : formatBytes(run.addedBytes),
                  })
                : t("status.failed", { when: when(run.finishedAt), error: run.error ?? "" })}
        </p>
        {run?.status === "succeeded" && run.error && (
          <p className="text-sm text-busy">{t("status.partial", { error: run.error })}</p>
        )}
        {data.nextRunAt && (
          <p className="text-sm text-muted">{t("status.next", { when: when(data.nextRunAt) })}</p>
        )}
        <div>
          <Button
            type="button"
            variant="secondary"
            pending={starting}
            disabled={!data.keyCreated || run?.status === "running" || data.restore?.status === "running"}
            onClick={() => void runNow()}
          >
            {t("status.runNow")}
          </Button>
        </div>
      </section>

      {data.keyCreated && (
        <section className="grid max-w-[850px] gap-3 border-t pt-5">
          <h3 className="font-medium">{t("snapshots.title")}</h3>
          <Snapshots />
        </section>
      )}

      {data.repository !== null && <RestoreGuide repository={data.repository} />}

      {data.keyCreated && (
        <section className="grid max-w-[850px] gap-3 border-t pt-5">
          <h3 className="font-medium">{t("key.reveal")}</h3>
          <RevealKey />
        </section>
      )}
    </div>
  );
}
