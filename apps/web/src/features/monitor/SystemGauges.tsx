import type { MetricsPoint, SystemMetrics } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, formatDateTime } from "../../lib/format";
import { Button, Gauge, Lamp, Pictogram, type PictogramName, Skeleton, Tooltip } from "../../ui";
import { useCurrentUser } from "../auth/session";
import { systemHistoryQuery, systemMetricsQuery } from "./api";
import { MetricsSettingsDialog } from "./MetricsSettingsDialog";
import { refreshInterval, useMetricsPreferences } from "./preferences";
import { TrendLine, type TrendPoint } from "./TrendLine";

const rate = (bytesPerSecond: number) => `${formatBytes(bytesPerSecond)}/s`;

const seriesOf = (
  points: readonly MetricsPoint[],
  value: (point: MetricsPoint) => number | null,
): TrendPoint[] => points.map((point) => ({ at: point.at, value: value(point) }));

function Instrument({
  pictogram,
  title,
  children,
  detail,
  trend,
}: {
  pictogram: PictogramName;
  title: string;
  children: React.ReactNode;
  detail: React.ReactNode;
  trend: React.ReactNode;
}) {
  return (
    <section className="grid min-w-0 gap-3 border-b p-4 last:border-b-0 sm:border-r sm:[&:nth-child(2n)]:border-r-0 xl:border-b-0 xl:[&:nth-child(2n)]:border-r xl:last:border-r-0">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Pictogram name={pictogram} size={16} />
        {title}
      </h3>
      <div className="flex items-center gap-4">
        {children}
        <div className="min-w-0 flex-1 text-xs text-muted">{detail}</div>
      </div>
      {trend}
    </section>
  );
}

function Readings({ current, history }: { current: SystemMetrics; history: readonly MetricsPoint[] }) {
  const { t } = useTranslation("monitor");
  const { cpu, memory, disk, network } = current;
  const netValue =
    network.rxBytesPerSecond === null || network.txBytesPerSecond === null
      ? null
      : network.rxBytesPerSecond + network.txBytesPerSecond;

  return (
    <>
      <Instrument
        pictogram="cpu"
        title={t("gauges.cpu")}
        detail={
          <>
            <p className="font-mono">
              {cpu.cores === null ? t("gauges.noData") : t("gauges.cores", { count: cpu.cores })}
            </p>
            {cpu.load !== null && (
              <p className="font-mono">{cpu.load.map((value) => value.toFixed(2)).join("  ")}</p>
            )}
          </>
        }
        trend={
          <TrendLine
            points={seriesOf(history, (point) => point.cpu)}
            label={t("gauges.cpu")}
            max={100}
            format={(value) => `${value.toFixed(1)}%`}
          />
        }
      >
        <Gauge
          value={cpu.percent}
          label={t("gauges.cpu")}
          valueText={cpu.percent === null ? undefined : `${cpu.percent.toFixed(1)}%`}
        />
      </Instrument>

      <Instrument
        pictogram="memory"
        title={t("gauges.memory")}
        detail={
          <p className="font-mono">
            {memory.usedBytes === null || memory.totalBytes === null
              ? t("gauges.noData")
              : `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`}
          </p>
        }
        trend={
          <TrendLine
            points={seriesOf(history, (point) => point.memoryUsed)}
            label={t("gauges.memory")}
            max={memory.totalBytes ?? undefined}
            format={formatBytes}
          />
        }
      >
        <Gauge
          value={memory.percent}
          label={t("gauges.memory")}
          valueText={
            memory.percent === null
              ? undefined
              : `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`
          }
        />
      </Instrument>

      <Instrument
        pictogram="disk"
        title={t("gauges.disk")}
        detail={
          <p className="font-mono">
            {disk.usedBytes === null || disk.totalBytes === null
              ? t("gauges.noData")
              : `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}`}
          </p>
        }
        trend={
          <TrendLine
            points={seriesOf(history, (point) => point.diskUsed)}
            label={t("gauges.disk")}
            max={disk.totalBytes ?? undefined}
            format={formatBytes}
          />
        }
      >
        <Gauge
          value={disk.percent}
          label={t("gauges.disk")}
          valueText={
            disk.percent === null
              ? undefined
              : `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}`
          }
        />
      </Instrument>

      <Instrument
        pictogram="network"
        title={t("gauges.network")}
        detail={
          <>
            <p className="font-mono">
              <span className="text-muted">{t("gauges.in")}</span>{" "}
              {network.rxBytesPerSecond === null ? t("gauges.noData") : rate(network.rxBytesPerSecond)}
            </p>
            <p className="font-mono">
              <span className="text-muted">{t("gauges.out")}</span>{" "}
              {network.txBytesPerSecond === null ? t("gauges.noData") : rate(network.txBytesPerSecond)}
            </p>
          </>
        }
        trend={
          <TrendLine
            points={seriesOf(history, (point) =>
              point.rx === null || point.tx === null ? null : point.rx + point.tx,
            )}
            label={t("gauges.network")}
            format={rate}
          />
        }
      >
        <NetworkReading value={netValue} />
      </Instrument>
    </>
  );
}

function NetworkReading({ value }: { value: number | null }) {
  const { t } = useTranslation("monitor");
  return (
    <span className="min-w-14 font-mono text-md tabular-nums" title={t("gauges.networkScope")}>
      {value === null ? "–" : rate(value)}
    </span>
  );
}

/** The four readings of the server, ready to place anywhere with one line. Administrators only. */
export function SystemGauges() {
  const user = useCurrentUser();
  return user?.role === "admin" ? <Gauges /> : null;
}

function Gauges() {
  const { t, i18n } = useTranslation("monitor");
  const [preferences] = useMetricsPreferences();
  const [configuring, setConfiguring] = useState(false);
  const current = useQuery(systemMetricsQuery(refreshInterval(preferences.refresh)));
  const history = useQuery(systemHistoryQuery(preferences.range, preferences.step));

  return (
    <section aria-label={t("gauges.label")} className="border-y">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <h2 className="eyebrow">{t("gauges.title")}</h2>
          {current.data !== undefined && !current.data.docker.available && (
            <Lamp
              state="failed"
              size="sm"
              showLabel
              label={
                current.data.docker.lastSeenAt === null
                  ? t("gauges.dockerAway")
                  : t("gauges.dockerAwaySince", {
                      when: formatDateTime(current.data.docker.lastSeenAt, i18n.language),
                    })
              }
            />
          )}
          {current.data !== undefined && (
            <span className="text-xs text-muted" title={t(`origin.${current.data.origin}`)}>
              {formatDateTime(current.data.readAt, i18n.language)}
            </span>
          )}
        </div>
        <Tooltip content={t("settings.open")}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("settings.open")}
            onClick={() => setConfiguring(true)}
          >
            <Settings2 aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
      </div>
      {current.isPending ? (
        <div className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((key) => (
            <Skeleton key={key} className="h-28" />
          ))}
        </div>
      ) : current.isError ? (
        <div className="p-4">
          <Lamp state="unknown" showLabel label={t("gauges.unavailable")} />
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 xl:grid-cols-4">
          <Readings current={current.data} history={history.data?.points ?? []} />
        </div>
      )}
      <MetricsSettingsDialog open={configuring} onOpenChange={setConfiguring} />
    </section>
  );
}
