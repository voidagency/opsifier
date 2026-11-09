import {
  actionEntry,
  type MetricsRange,
  type MetricsStep,
  metricsHistory,
  monitoringOverview,
  retainedVolumeList,
  servicesTrends,
  storageReport,
  systemMetrics,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../lib/api";

export const monitorKey = ["monitor"] as const;

export const systemMetricsQuery = (refreshMs: number | false) =>
  queryOptions({
    queryKey: ["monitor", "system"] as const,
    queryFn: ({ signal }) => api.get("/monitor/system", { schema: systemMetrics, signal }),
    refetchInterval: refreshMs,
    refetchIntervalInBackground: false,
    retry: false,
  });

export const systemHistoryQuery = (range: MetricsRange, step: MetricsStep) =>
  queryOptions({
    queryKey: ["monitor", "history", range, step] as const,
    queryFn: ({ signal }) =>
      api.get("/monitor/system/history", { schema: metricsHistory, query: { range, step }, signal }),
    refetchInterval: 40_000,
    retry: false,
  });

export const serviceHistoryQuery = (
  project: string,
  service: string,
  range: MetricsRange,
  step: MetricsStep,
) =>
  queryOptions({
    queryKey: ["monitor", "service-history", project, service, range, step] as const,
    queryFn: ({ signal }) =>
      api.get(`/projects/${project}/services/${service}/metrics/history`, {
        schema: metricsHistory,
        query: { range, step },
        signal,
      }),
    retry: false,
  });

export const trendsQuery = queryOptions({
  queryKey: ["monitor", "trends"] as const,
  queryFn: ({ signal }) => api.get("/monitor/services/trends", { schema: servicesTrends, signal }),
  refetchInterval: 60_000,
  retry: false,
});

export const retainedVolumesQuery = queryOptions({
  queryKey: ["monitor", "retained-volumes"] as const,
  queryFn: ({ signal }) => api.get("/retained-volumes", { schema: retainedVolumeList, signal }),
  refetchInterval: 5_000,
  retry: false,
});

export const retainedVolumesApi = {
  delete: (name: string) =>
    api.delete(`/retained-volumes/${encodeURIComponent(name)}`, {
      body: { confirm: name },
      schema: actionEntry,
    }),
};

export const storageQuery = queryOptions({
  queryKey: ["monitor", "storage"] as const,
  queryFn: ({ signal }) => api.get("/monitor/storage", { schema: storageReport, signal }),
  refetchInterval: 5_000,
  retry: false,
});

export const monitoringSettingsQuery = queryOptions({
  queryKey: ["monitor", "settings"] as const,
  queryFn: ({ signal }) => api.get("/settings/monitoring", { schema: monitoringOverview, signal }),
  retry: false,
});
