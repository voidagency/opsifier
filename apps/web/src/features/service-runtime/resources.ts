import type { ServiceMetrics, ServicesMetrics, TaskMetrics } from "@opsifier/contract";
import { servicesMetrics, servicesMetricsTopic } from "@opsifier/contract";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { formatBytes, formatPercent } from "../../lib/format";
import { useTopic } from "../../lib/realtime";

/** Whether the page is on screen. A tab in the background watches nothing. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/** What a service is using and what it may use, summed across its running tasks. */
export type ServiceResources = Pick<
  ServiceMetrics,
  "cpuPercent" | "cpuCapacityPercent" | "memoryUsedBytes" | "memoryLimitBytes"
>;

/** A value against its limit, ready for a `Gauge` or a `GaugeBar`. A null value draws the no-data state. */
export interface ResourceReading {
  value: number | null;
  max: number;
  /** The reading in words, for the tooltip and assistive technology. */
  valueText?: string;
}

const NO_READING: ResourceReading = { value: null, max: 100 };

/** Whole cores print plainly, otherwise two decimals: 4, 0.5, 1.25. */
const cores = (percent: number) => String(Number((percent / 100).toFixed(2)));

export function cpuReading(resources: ServiceResources | undefined, t: TFunction): ResourceReading {
  if (
    resources === undefined ||
    resources.cpuPercent === null ||
    resources.cpuCapacityPercent === null ||
    resources.cpuCapacityPercent <= 0
  ) {
    return NO_READING;
  }
  return {
    value: resources.cpuPercent,
    max: resources.cpuCapacityPercent,
    valueText: t("metrics.cpuText", {
      ns: "services",
      used: cores(resources.cpuPercent),
      total: cores(resources.cpuCapacityPercent),
    }),
  };
}

export function memoryReading(resources: ServiceResources | undefined, t: TFunction): ResourceReading {
  if (
    resources === undefined ||
    resources.memoryUsedBytes === null ||
    resources.memoryLimitBytes === null ||
    resources.memoryLimitBytes <= 0
  ) {
    return NO_READING;
  }
  return {
    value: resources.memoryUsedBytes,
    max: resources.memoryLimitBytes,
    valueText: t("metrics.memoryText", {
      ns: "services",
      used: formatBytes(resources.memoryUsedBytes),
      total: formatBytes(resources.memoryLimitBytes),
    }),
  };
}

/** The share of the limit as a figure with one decimal, the same way everywhere. */
export function shareOfLimit({ value, max }: ResourceReading): string | undefined {
  return value === null ? undefined : formatPercent(Math.min((value / max) * 100, 100));
}

export const resourcesKey = (project: string, service: string) => `${project}/${service}`;

/** Adds what is known. A figure no task reported stays unknown instead of becoming zero. */
const plus = (total: number | null, value: number | null): number | null =>
  value === null ? total : (total ?? 0) + value;

function sumTasks(tasks: readonly TaskMetrics[]): ServiceResources {
  return tasks.reduce<ServiceResources>(
    (total, task) => ({
      cpuPercent: plus(total.cpuPercent, task.cpuPercent),
      cpuCapacityPercent: plus(total.cpuCapacityPercent, task.cpuCapacityPercent),
      memoryUsedBytes: plus(total.memoryUsedBytes, task.memoryUsedBytes),
      memoryLimitBytes: plus(total.memoryLimitBytes, task.memoryLimitBytes),
    }),
    { cpuPercent: null, cpuCapacityPercent: null, memoryUsedBytes: null, memoryLimitBytes: null },
  );
}

/**
 * What every running service is using, keyed with `resourcesKey`, for pages that list several.
 * The server only samples while someone is subscribed, so this is live only while the page is on screen.
 */
export function useAllServiceResources(): ReadonlyMap<string, ServiceResources> {
  const visible = usePageVisible();
  const [reading, setReading] = useState<ServicesMetrics | null>(null);

  useTopic<ServicesMetrics>(visible ? servicesMetricsTopic : null, (payload) => {
    const sample = servicesMetrics.safeParse(payload).data;
    if (sample !== undefined) {
      setReading(sample);
    }
  });

  return useMemo(
    () =>
      new Map(
        (reading?.available ? reading.services : []).map((service) => [
          resourcesKey(service.projectName, service.serviceName),
          sumTasks(service.tasks),
        ]),
      ),
    [reading],
  );
}
