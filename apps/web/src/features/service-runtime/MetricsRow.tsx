import { type ServiceMetrics, serviceMetrics, serviceMetricsTopic } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes, formatPercent } from "../../lib/format";
import { useTopic } from "../../lib/realtime";
import { metricsQuery } from "../services/api";

/** Whether the page is on screen. A tab in the background watches nothing. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/** The latest readings of a service, of any type. They only update while someone is looking at them. */
export function MetricsRow({ project, service }: { project: string; service: string }) {
  const { t } = useTranslation("services");
  const queryClient = useQueryClient();
  const query = metricsQuery(project, service);
  const { data } = useQuery(query);
  const visible = usePageVisible();

  useTopic<ServiceMetrics>(visible ? serviceMetricsTopic(project, service) : null, (payload) => {
    const sample = serviceMetrics.safeParse(payload).data;
    if (sample !== undefined) {
      queryClient.setQueryData(query.queryKey, sample);
    }
  });

  const figures = [
    [t("metrics.cpu"), formatPercent(data?.cpuPercent)],
    [t("metrics.memory"), formatBytes(data?.memoryUsedBytes)],
    [t("metrics.networkIn"), formatBytes(data?.networkRxBytes)],
    [t("metrics.networkOut"), formatBytes(data?.networkTxBytes)],
  ] as const;
  return (
    <dl className="mb-3 flex flex-wrap gap-x-8 gap-y-1">
      {figures.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-2">
          <dt className="eyebrow">{label}</dt>
          <dd className="font-mono text-sm tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
