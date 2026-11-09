import { type ServicesMetrics, servicesMetrics, servicesMetricsTopic } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, formatDateTime } from "../../lib/format";
import { useTopic } from "../../lib/realtime";
import {
  countStates,
  Dialog,
  EmptyState,
  ErrorState,
  HealthSummary,
  PageHeader,
  Skeleton,
  stateFromService,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type VisualState,
} from "../../ui";
import { useCurrentUser } from "../auth/session";
import { projectsQuery } from "../projects/api";
import { serviceHistoryQuery, trendsQuery } from "./api";
import { EventsPanel } from "./EventsPanel";
import { useMetricsPreferences } from "./preferences";
import { ServicesTable } from "./ServicesTable";
import { StoragePanel } from "./StoragePanel";
import { SystemGauges } from "./SystemGauges";
import { TrendLine } from "./TrendLine";

/** Whether the page is on screen. A background tab watches nothing and asks for nothing. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

function ServiceHistoryDialog({
  target,
  onClose,
}: {
  target: { project: string; service: string } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("monitor");
  const [preferences] = useMetricsPreferences();
  const history = useQuery({
    ...serviceHistoryQuery(target?.project ?? "", target?.service ?? "", preferences.range, preferences.step),
    enabled: target !== null,
  });
  const points = history.data?.points ?? [];
  const series = (value: (typeof points)[number]) => value;

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => !open && onClose()}
      title={target === null ? "" : t("history.title", { service: `${target.project}/${target.service}` })}
      size="lg"
    >
      {history.isPending ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="grid gap-4">
          {history.data !== undefined && (
            <p className="text-xs text-muted" title={t("historyScope")}>
              {t(`origin.${history.data.origin}`)} ·{" "}
              {t("history.step", { minutes: Math.round(history.data.stepSeconds / 60) })}
            </p>
          )}
          <TrendLine
            label={t("columns.cpu")}
            format={(value) => `${value.toFixed(1)}%`}
            points={points.map((p) => ({ at: series(p).at, value: p.cpu }))}
          />
          <TrendLine
            label={t("columns.memory")}
            format={formatBytes}
            points={points.map((p) => ({ at: p.at, value: p.memoryUsed }))}
          />
          <TrendLine
            label={t("history.disk")}
            format={formatBytes}
            points={points.map((p) => ({ at: p.at, value: p.diskUsed }))}
          />
          <TrendLine
            label={t("columns.networkIn")}
            format={(value) => `${formatBytes(value)}/s`}
            points={points.map((p) => ({ at: p.at, value: p.rx }))}
          />
          <TrendLine
            label={t("columns.networkOut")}
            format={(value) => `${formatBytes(value)}/s`}
            points={points.map((p) => ({ at: p.at, value: p.tx }))}
          />
        </div>
      )}
    </Dialog>
  );
}

function ServicesPanel({ filter, reading }: { filter: VisualState | null; reading: ServicesMetrics | null }) {
  const { t, i18n } = useTranslation("monitor");
  const { data } = useQuery(projectsQuery);
  const { data: trends } = useQuery(trendsQuery);
  const [selected, setSelected] = useState<{ project: string; service: string } | null>(null);

  const states = useMemo(() => {
    const map = new Map<string, VisualState>();
    for (const project of data?.projects ?? []) {
      for (const service of project.services) {
        map.set(`${project.name}/${service.name}`, stateFromService(service));
      }
    }
    return map;
  }, [data]);

  const visible = useMemo(() => {
    if (filter === null) {
      return null;
    }
    return new Set([...states].filter(([, state]) => state === filter).map(([key]) => key));
  }, [filter, states]);

  if (reading === null) {
    return <Skeleton className="h-24 max-w-[1200px]" />;
  }
  if (!reading.available) {
    return (
      <div className="grid justify-items-start gap-2">
        <ErrorState message={t("unavailable")} />
        <p className="text-sm text-muted">
          {reading.lastReadAt === null
            ? t("neverMeasured")
            : t("lastMeasured", { when: formatDateTime(reading.lastReadAt, i18n.language) })}
        </p>
      </div>
    );
  }
  if (reading.services.length === 0) {
    return (
      <EmptyState illustration="no-services" title={t("empty.title")} description={t("empty.description")} />
    );
  }
  return (
    <>
      {reading.readAt !== null && (
        <p className="mb-2 text-xs text-muted" title={t("tableScope")}>
          {t(`origin.${reading.origin}`)} · {formatDateTime(reading.readAt, i18n.language)}
        </p>
      )}
      <ServicesTable
        reading={reading}
        visible={visible}
        stateOf={(project, service) => states.get(`${project}/${service}`) ?? "unknown"}
        trends={trends?.trends ?? {}}
        onSelect={(project, service) => setSelected({ project, service })}
      />
      <ServiceHistoryDialog target={selected} onClose={() => setSelected(null)} />
    </>
  );
}

/** What every task on the server is using. Sampled only while this page is open and on screen. */
export function MonitorPage() {
  const { t } = useTranslation("monitor");
  const user = useCurrentUser();
  const [reading, setReading] = useState<ServicesMetrics | null>(null);
  const [filter, setFilter] = useState<VisualState | null>(null);
  const visible = usePageVisible();
  const { data } = useQuery(projectsQuery);

  useTopic<ServicesMetrics>(visible ? servicesMetricsTopic : null, (payload) => {
    const sample = servicesMetrics.safeParse(payload).data;
    if (sample !== undefined) {
      setReading(sample);
    }
  });

  const counts = useMemo(
    () =>
      countStates(
        (data?.projects ?? []).flatMap((project) =>
          project.services.map((service) => stateFromService(service)),
        ),
      ),
    [data],
  );

  if (user !== null && user.role !== "admin") {
    return (
      <EmptyState
        className="px-4 py-6 md:px-6 lg:px-8"
        illustration="not-found"
        title={t("restricted.title")}
        description={t("restricted.description")}
      />
    );
  }

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 px-4 py-6 md:px-6 lg:px-8">
        <HealthSummary counts={counts} selected={filter} onSelect={setFilter} />
        <SystemGauges />
        <Tabs defaultValue="services">
          <TabsList>
            <TabsTrigger value="services">{t("tabs.services")}</TabsTrigger>
            <TabsTrigger value="events">{t("tabs.events")}</TabsTrigger>
            <TabsTrigger value="storage">{t("tabs.storage")}</TabsTrigger>
          </TabsList>
          <TabsContent value="services" className="pt-4">
            <ServicesPanel filter={filter} reading={reading} />
          </TabsContent>
          <TabsContent value="events" className="pt-4">
            <EventsPanel />
          </TabsContent>
          <TabsContent value="storage" className="pt-4">
            <StoragePanel />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
