import { type ServiceMetrics, serviceMetrics, serviceMetricsTopic } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, formatDateTime, formatPercent, NO_VALUE } from "../../lib/format";
import { useTopic } from "../../lib/realtime";
import { Gauge, GaugeBar, Lamp, Pictogram, type PictogramName, Sparkline } from "../../ui";
import { metricsQuery } from "../services/api";
import { cpuReading, memoryReading, type ResourceReading, shareOfLimit, usePageVisible } from "./resources";

/** Readings kept for the trend lines: about two minutes at the server's pace. */
const HISTORY_LENGTH = 40;

/** The traffic a bar is measured against: one gigabit per second, the usual server link. */
const LINK_BYTES_PER_SECOND = 125_000_000;

interface HistoryPoint {
  at: number;
  rxBytes: number | null;
  txBytes: number | null;
  cpu: number | null;
  memory: number | null;
  /** Bytes per second since the reading before it. Null when there was none, or the counters reset. */
  rx: number | null;
  tx: number | null;
}

/** A share of a limit, or null when either figure wasn't reported. */
const shareOf = (value: number | null, limit: number | null): number | null =>
  value === null || limit === null || limit <= 0 ? null : (value / limit) * 100;

function nextPoint(metrics: ServiceMetrics, previous: HistoryPoint | undefined): HistoryPoint {
  const at = Date.parse(metrics.readAt as string);
  const seconds = previous === undefined ? 0 : (at - previous.at) / 1000;
  const rate = (now: number | null, before: number | null | undefined) =>
    now === null || before === null || before === undefined || seconds <= 0 || now < before
      ? null
      : (now - before) / seconds;
  return {
    at,
    rxBytes: metrics.networkRxBytes,
    txBytes: metrics.networkTxBytes,
    cpu: shareOf(metrics.cpuPercent, metrics.cpuCapacityPercent),
    memory: shareOf(metrics.memoryUsedBytes, metrics.memoryLimitBytes),
    rx: rate(metrics.networkRxBytes, previous?.rxBytes),
    tx: rate(metrics.networkTxBytes, previous?.txBytes),
  };
}

/** The readings seen since this page opened, oldest first. A service with nothing running adds none. */
function useHistory(metrics: ServiceMetrics | undefined): readonly HistoryPoint[] {
  const [history, setHistory] = useState<readonly HistoryPoint[]>([]);
  useEffect(() => {
    if (metrics === undefined || metrics.readAt === null) {
      return;
    }
    setHistory((current) => {
      const last = current.at(-1);
      // A push can overtake the first fetch: only ever move forward in time.
      return last !== undefined && Date.parse(metrics.readAt as string) <= last.at
        ? current
        : [...current, nextPoint(metrics, last)].slice(-HISTORY_LENGTH);
    });
  }, [metrics]);
  return history;
}

/** Whether there is room for full-size instruments. */
function useRoomy(): boolean {
  const [roomy, setRoomy] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setRoomy(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return roomy;
}

function Heading({ pictogram, children }: { pictogram: PictogramName; children: ReactNode }) {
  return (
    <span className="eyebrow flex items-center gap-1.5">
      <Pictogram name={pictogram} size={16} />
      {children}
    </span>
  );
}

interface InstrumentProps {
  pictogram: PictogramName;
  label: string;
  reading: ResourceReading;
  /** What the gauge is measuring, in plain figures. */
  figures: string;
  trend: ReadonlyArray<number | null>;
  roomy: boolean;
}

/** One ring gauge with its name, plain figures and trend. */
function Instrument({ pictogram, label, reading, figures, trend, roomy }: InstrumentProps) {
  const { t } = useTranslation("services");
  return (
    <div className="flex min-w-0 items-center gap-3 py-2.5 pr-4">
      <Gauge
        value={reading.value}
        max={reading.max}
        label={label}
        size={roomy ? "md" : "sm"}
        display={shareOfLimit(reading)}
        valueText={reading.valueText}
      />
      <div className="grid min-w-0 justify-items-start gap-1">
        <Heading pictogram={pictogram}>{label}</Heading>
        <span className="font-mono text-xs text-muted tabular-nums">{figures}</span>
        {roomy && (
          <Sparkline
            values={trend}
            label={t("metrics.trend", { metric: label })}
            valueText={reading.valueText}
            max={100}
            width={96}
            height={20}
          />
        )}
      </div>
    </div>
  );
}

interface FlowProps {
  label: string;
  rate: number | null;
  trend: ReadonlyArray<number | null>;
  total: string;
  roomy: boolean;
}

/** One direction of traffic: how fast it is flowing, its trend, and what has gone through so far. */
function Flow({ label, rate, trend, total, roomy }: FlowProps) {
  const { t } = useTranslation("services");
  const speed = rate === null ? undefined : `${formatBytes(rate)}/s`;
  return (
    <div className="grid min-w-0 content-center gap-1.5 py-2.5 pr-4">
      <div className="flex items-center gap-3">
        <Heading pictogram="network">{label}</Heading>
        {roomy && (
          <Sparkline
            values={trend}
            label={t("metrics.trend", { metric: label })}
            valueText={speed}
            width={88}
            height={20}
            className="hidden xl:inline-flex"
          />
        )}
        <span className="ml-auto font-mono text-xs whitespace-nowrap text-muted tabular-nums">{total}</span>
      </div>
      <GaugeBar value={rate} max={LINK_BYTES_PER_SECOND} label={label} display={speed} valueText={speed} />
    </div>
  );
}

/** What the figures are and when they were taken, or, with none to show, why and since when. */
function ReadingNote({ reading }: { reading: ServiceMetrics }) {
  const { t, i18n } = useTranslation("services");
  const lastRead =
    reading.lastReadAt === null
      ? t("metrics.neverRead")
      : t("metrics.lastRead", { when: formatDateTime(reading.lastReadAt, i18n.language) });
  if (!reading.available) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 pb-2 text-xs text-muted">
        <Lamp state="unknown" size="sm" showLabel label={t("metrics.dockerAway")} />
        <span>{lastRead}</span>
      </p>
    );
  }
  if (reading.readAt === null) {
    return (
      <p className="pb-2 text-xs text-muted">
        {t("metrics.notRunning")} · {lastRead}
      </p>
    );
  }
  const hint = reading.origin === "simulated" ? "metrics.scopeHintSimulated" : "metrics.scopeHint";
  return (
    <p className="w-fit pb-2 text-xs text-muted" title={t(hint)}>
      {t("metrics.scope", { count: reading.tasks })} · {t(`metrics.origins.${reading.origin}`)} ·{" "}
      <time dateTime={reading.readAt}>{formatDateTime(reading.readAt, i18n.language)}</time>
    </p>
  );
}

/** The latest readings of a service, of any type. They only update while someone is looking at them. */
export function MetricsRow({ project, service }: { project: string; service: string }) {
  const { t } = useTranslation("services");
  const queryClient = useQueryClient();
  const query = metricsQuery(project, service);
  const { data } = useQuery(query);
  const visible = usePageVisible();
  const roomy = useRoomy();
  const history = useHistory(data);

  useTopic<ServiceMetrics>(visible ? serviceMetricsTopic(project, service) : null, (payload) => {
    const sample = serviceMetrics.safeParse(payload).data;
    if (sample !== undefined) {
      queryClient.setQueryData(query.queryKey, sample);
    }
  });

  // No timestamp means nothing was read: the instruments draw that instead of a zero.
  const live = data?.readAt === null ? undefined : data;
  const cpu = cpuReading(live, t);
  const memory = memoryReading(live, t);
  const latest = history.at(-1);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would need a legend inside this strip of instruments
    <div role="group" aria-label={t("metrics.label")} className="@container mb-3 border-t">
      <div className="grid grid-cols-2 gap-x-4 @3xl:grid-cols-[auto_auto_minmax(0,1fr)_minmax(0,1fr)]">
        <Instrument
          pictogram="cpu"
          label={t("metrics.cpu")}
          reading={cpu}
          figures={live === undefined ? NO_VALUE : (cpu.valueText ?? formatPercent(live.cpuPercent))}
          trend={history.map((point) => point.cpu)}
          roomy={roomy}
        />
        <Instrument
          pictogram="memory"
          label={t("metrics.memory")}
          reading={memory}
          figures={live === undefined ? NO_VALUE : (memory.valueText ?? formatBytes(live.memoryUsedBytes))}
          trend={history.map((point) => point.memory)}
          roomy={roomy}
        />
        <Flow
          label={t("metrics.networkIn")}
          rate={latest?.rx ?? null}
          trend={history.map((point) => point.rx)}
          total={live === undefined ? NO_VALUE : formatBytes(live.networkRxBytes)}
          roomy={roomy}
        />
        <Flow
          label={t("metrics.networkOut")}
          rate={latest?.tx ?? null}
          trend={history.map((point) => point.tx)}
          total={live === undefined ? NO_VALUE : formatBytes(live.networkTxBytes)}
          roomy={roomy}
        />
      </div>
      {data !== undefined && <ReadingNote reading={data} />}
    </div>
  );
}
