import type { MonitoringOverview } from "@opsifier/contract";
import { scrapeIntervals } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, formatDateTime } from "../../../lib/format";
import { errorMessage, useForm } from "../../../lib/forms";
import {
  Button,
  ErrorState,
  Field,
  FormBanner,
  GaugeBar,
  Input,
  Lamp,
  Select,
  Skeleton,
  Switch,
  toast,
} from "../../../ui";
import { monitoringSettingsQuery } from "../../monitor/api";
import { saveMonitoringSettings } from "./api";

interface Values {
  metricsEnabled: boolean;
  metricsRetention: string;
  metricsUnit: "days" | "gb";
  scrapeSeconds: string;
  logsEnabled: boolean;
  logsRetention: string;
  logsUnit: "days" | "hours";
  logsMaxSizeMb: string;
  [key: string]: unknown;
}

const blank: Values = {
  metricsEnabled: true,
  metricsRetention: "7",
  metricsUnit: "days",
  scrapeSeconds: "15",
  logsEnabled: false,
  logsRetention: "7",
  logsUnit: "days",
  logsMaxSizeMb: "1024",
};

function fromSettings(data: MonitoringOverview): Values {
  return {
    metricsEnabled: data.metrics.enabled,
    metricsRetention: String(data.metrics.retention),
    metricsUnit: data.metrics.retentionUnit,
    scrapeSeconds: String(data.metrics.scrapeSeconds),
    logsEnabled: data.logs.enabled,
    logsRetention: String(data.logs.retention),
    logsUnit: data.logs.retentionUnit,
    logsMaxSizeMb: String(data.logs.maxSizeMb),
  };
}

/** How much history the panel keeps, and what keeping it costs. Bounded both ways. */
export function MonitoringPage() {
  const { t, i18n } = useTranslation(["settings-monitoring", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(monitoringSettingsQuery);
  const form = useForm<Values>({
    t,
    initialValues: blank,
    validate: (values) => {
      const errors: Partial<Record<keyof Values & string, string>> = {};
      if (!(Number(values.metricsRetention) > 0)) {
        errors.metricsRetention = t("errors.retention");
      }
      if (!(Number(values.logsRetention) > 0)) {
        errors.logsRetention = t("errors.retention");
      }
      if (!Number.isInteger(Number(values.logsMaxSizeMb)) || Number(values.logsMaxSizeMb) < 10) {
        errors.logsMaxSizeMb = t("errors.size");
      }
      return errors;
    },
    onSubmit: async (values) => {
      await saveMonitoringSettings({
        metrics: {
          enabled: values.metricsEnabled,
          retention: Number(values.metricsRetention),
          retentionUnit: values.metricsUnit,
          scrapeSeconds: Number(values.scrapeSeconds) as (typeof scrapeIntervals)[number],
        },
        logs: {
          enabled: values.logsEnabled,
          retention: Number(values.logsRetention),
          retentionUnit: values.logsUnit,
          maxSizeMb: Number(values.logsMaxSizeMb),
        },
      });
      await queryClient.invalidateQueries({ queryKey: monitoringSettingsQuery.queryKey });
      toast.success(t("saved"));
    },
  });
  const { reset } = form;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refill only when the stored settings arrive
  useEffect(() => {
    if (data !== undefined) {
      reset(fromSettings(data));
    }
  }, [data]);

  if (isPending) {
    return <Skeleton className="m-6 h-40" />;
  }
  if (isError) {
    return <ErrorState className="m-6" message={errorMessage(error, t)} onRetry={() => refetch()} />;
  }

  const formatDate = (iso: string | null) => (iso === null ? "–" : formatDateTime(iso, i18n.language));

  const logMax = Number(form.values.logsMaxSizeMb) * 1024 * 1024 || 1;

  return (
    <form
      onSubmit={form.handleSubmit}
      noValidate
      className="grid grid-cols-[minmax(0,1fr)] gap-6 px-4 py-6 md:px-6 lg:px-8"
    >
      <div>
        <h2 className="text-md font-medium">{t("title")}</h2>
        <p className="mt-1 max-w-[60ch] text-sm text-muted">{t("description")}</p>
      </div>
      {form.banner && <FormBanner>{form.banner}</FormBanner>}

      <section className="grid max-w-[850px] gap-4 border-t pt-5">
        <div className="flex items-center gap-2">
          <Lamp state={form.values.metricsEnabled ? "running" : "stopped"} />
          <h3 className="font-medium">{t("metrics.title")}</h3>
        </div>
        <Switch
          label={t("metrics.enabled")}
          hint={t("metrics.enabledHint")}
          checked={form.values.metricsEnabled}
          onCheckedChange={(checked) => form.set("metricsEnabled", checked)}
        />
        <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr]">
          <Field label={t("retention")} error={form.errors.metricsRetention} hint={t("retentionHint")}>
            <Input {...form.field("metricsRetention")} inputMode="decimal" mono />
          </Field>
          <Field label={t("unit")} hint={t("unitHint")}>
            <Select
              value={form.values.metricsUnit}
              onValueChange={(value) => form.set("metricsUnit", value as Values["metricsUnit"])}
              className="w-28"
              options={[
                { value: "days", label: t("units.days") },
                { value: "gb", label: t("units.gb") },
              ]}
            />
          </Field>
          <Field label={t("metrics.interval")} hint={t("metrics.intervalHint")}>
            <Select
              value={form.values.scrapeSeconds}
              onValueChange={(value) => form.set("scrapeSeconds", value)}
              options={scrapeIntervals.map((seconds) => ({
                value: String(seconds),
                label:
                  seconds >= 60
                    ? t("everyMinutes", { count: seconds / 60 })
                    : t("everySeconds", { count: seconds }),
              }))}
            />
          </Field>
        </div>
        <dl className="grid gap-1.5 text-sm">
          <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-2">
            <dt className="text-muted">{t("usage")}</dt>
            <dd>
              <GaugeBar
                value={data.store.approximateBytes}
                max={Math.max(
                  form.values.metricsUnit === "gb"
                    ? Number(form.values.metricsRetention) * 1024 ** 3
                    : 64 * 1024 ** 2,
                  1,
                )}
                label={t("usage")}
                display={formatBytes(data.store.approximateBytes)}
              />
            </dd>
          </div>
          <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
            <dt className="text-muted">{t("oldest")}</dt>
            <dd className="font-mono text-xs">{formatDate(data.store.oldestAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="grid max-w-[850px] gap-4 border-t pt-5">
        <div className="flex items-center gap-2">
          <Lamp state={form.values.logsEnabled ? "running" : "stopped"} />
          <h3 className="font-medium">{t("logs.title")}</h3>
        </div>
        <Switch
          label={t("logs.enabled")}
          hint={t("logs.enabledHint")}
          checked={form.values.logsEnabled}
          onCheckedChange={(checked) => form.set("logsEnabled", checked)}
        />
        <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr]">
          <Field label={t("retention")} error={form.errors.logsRetention} hint={t("retentionHint")}>
            <Input {...form.field("logsRetention")} inputMode="decimal" mono />
          </Field>
          <Field label={t("unit")} hint={t("unitHint")}>
            <Select
              value={form.values.logsUnit}
              onValueChange={(value) => form.set("logsUnit", value as Values["logsUnit"])}
              className="w-28"
              options={[
                { value: "days", label: t("units.days") },
                { value: "hours", label: t("units.hours") },
              ]}
            />
          </Field>
          <Field label={t("logs.maxSize")} error={form.errors.logsMaxSizeMb} hint={t("logs.maxSizeHint")}>
            <Input {...form.field("logsMaxSizeMb")} inputMode="numeric" mono />
          </Field>
        </div>
        <dl className="grid gap-1.5 text-sm">
          <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-2">
            <dt className="text-muted">{t("usage")}</dt>
            <dd>
              <GaugeBar
                value={data.logStore.approximateBytes}
                max={logMax}
                label={t("usage")}
                display={formatBytes(data.logStore.approximateBytes)}
              />
            </dd>
          </div>
          <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
            <dt className="text-muted">{t("oldest")}</dt>
            <dd className="font-mono text-xs">{formatDate(data.logStore.oldestAt)}</dd>
          </div>
        </dl>
      </section>

      <div>
        <Button type="submit" variant="primary" pending={form.pending}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
