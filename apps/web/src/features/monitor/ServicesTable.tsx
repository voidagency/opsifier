import type { ServicesMetrics, TaskMetrics } from "@opsifier/contract";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { formatBytes, NO_VALUE } from "../../lib/format";
import { GaugeBar, Lamp, Sparkline, Table, TBody, TD, TH, THead, TR, type VisualState } from "../../ui";

type SortKey = "cpu" | "memory" | "memoryPercent" | "rx" | "tx";

interface Totals {
  cpuPercent: number | null;
  cpuCapacityPercent: number | null;
  memoryUsedBytes: number | null;
  memoryLimitBytes: number | null;
  networkRxBytes: number | null;
  networkTxBytes: number | null;
}

/** Adds what is known. A figure no task reported stays unknown instead of becoming zero. */
const plus = (total: number | null, value: number | null): number | null =>
  value === null ? total : (total ?? 0) + value;

const sum = (tasks: readonly TaskMetrics[]): Totals =>
  tasks.reduce<Totals>(
    (total, task) => ({
      cpuPercent: plus(total.cpuPercent, task.cpuPercent),
      cpuCapacityPercent: plus(total.cpuCapacityPercent, task.cpuCapacityPercent),
      memoryUsedBytes: plus(total.memoryUsedBytes, task.memoryUsedBytes),
      memoryLimitBytes:
        task.memoryLimitBytes === null
          ? total.memoryLimitBytes
          : Math.max(total.memoryLimitBytes ?? 0, task.memoryLimitBytes),
      networkRxBytes: plus(total.networkRxBytes, task.networkRxBytes),
      networkTxBytes: plus(total.networkTxBytes, task.networkTxBytes),
    }),
    {
      cpuPercent: null,
      cpuCapacityPercent: null,
      memoryUsedBytes: null,
      memoryLimitBytes: null,
      networkRxBytes: null,
      networkTxBytes: null,
    },
  );

const memoryPercent = (totals: Totals): number | null =>
  totals.memoryUsedBytes === null || totals.memoryLimitBytes === null || totals.memoryLimitBytes <= 0
    ? null
    : (totals.memoryUsedBytes / totals.memoryLimitBytes) * 100;

/** Rows with no figure go last whichever way the column is sorted. */
const sortValue = (totals: Totals, key: SortKey): number | null => {
  switch (key) {
    case "cpu":
      return totals.cpuPercent;
    case "memory":
      return totals.memoryUsedBytes;
    case "memoryPercent":
      return memoryPercent(totals);
    case "rx":
      return totals.networkRxBytes;
    case "tx":
      return totals.networkTxBytes;
  }
};

function Readings({ totals }: { totals: Totals }) {
  const { t } = useTranslation("monitor");
  const percent = memoryPercent(totals);
  const capacity = totals.cpuCapacityPercent !== null && totals.cpuCapacityPercent > 0;
  return (
    <>
      <TD numeric className="w-40">
        <GaugeBar
          value={capacity ? totals.cpuPercent : null}
          max={capacity ? (totals.cpuCapacityPercent as number) : 100}
          label={t("columns.cpu")}
          display={totals.cpuPercent === null ? NO_VALUE : `${totals.cpuPercent.toFixed(1)}%`}
        />
      </TD>
      <TD mono numeric>
        {formatBytes(totals.memoryUsedBytes)}
      </TD>
      <TD numeric className="w-36">
        <GaugeBar
          value={percent}
          label={t("columns.memoryPercent")}
          display={percent === null ? NO_VALUE : `${percent.toFixed(1)}%`}
        />
      </TD>
      <TD mono numeric>
        {formatBytes(totals.networkRxBytes)}
      </TD>
      <TD mono numeric>
        {formatBytes(totals.networkTxBytes)}
      </TD>
    </>
  );
}

interface ServicesTableProps {
  reading: ServicesMetrics;
  /** Keeps only these services, when the summary above the table is filtering. */
  visible: ReadonlySet<string> | null;
  stateOf: (project: string, service: string) => VisualState;
  trends: Readonly<Record<string, ReadonlyArray<number | null>>>;
  onSelect: (project: string, service: string) => void;
}

/** Project, then service, then task, sorted by whichever column was picked. */
export function ServicesTable({ reading, visible, stateOf, trends, onSelect }: ServicesTableProps) {
  const { t } = useTranslation("monitor");
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean } | null>(null);

  const groups = useMemo(() => {
    const direction = sort?.descending === false ? 1 : -1;
    const byValue = (a: Totals, b: Totals) => {
      if (sort === null) {
        return 0;
      }
      const [left, right] = [sortValue(a, sort.key), sortValue(b, sort.key)];
      if (left === null || right === null) {
        return Number(left === null) - Number(right === null);
      }
      return (left - right) * direction;
    };
    const services = reading.services
      .filter((service) => visible === null || visible.has(`${service.projectName}/${service.serviceName}`))
      .map((service) => ({ ...service, totals: sum(service.tasks) }));
    const projects = [...new Set(services.map((service) => service.projectName))].map((projectName) => {
      const members = services
        .filter((service) => service.projectName === projectName)
        .sort((a, b) => byValue(a.totals, b.totals) || a.serviceName.localeCompare(b.serviceName));
      return { projectName, services: members, totals: sum(members.flatMap((service) => service.tasks)) };
    });
    return projects.sort((a, b) => byValue(a.totals, b.totals) || a.projectName.localeCompare(b.projectName));
  }, [reading, sort, visible]);

  const header = (key: SortKey, label: string) => {
    const active = sort?.key === key;
    return (
      <TH numeric aria-sort={active ? (sort?.descending ? "descending" : "ascending") : "none"}>
        <button
          type="button"
          className="inline-flex items-center gap-1 hover:text-ink"
          onClick={() =>
            setSort(
              active && sort?.descending
                ? { key, descending: false }
                : active
                  ? null
                  : { key, descending: true },
            )
          }
        >
          {label}
          {active &&
            (sort?.descending ? (
              <ArrowDown aria-hidden="true" className="size-3" />
            ) : (
              <ArrowUp aria-hidden="true" className="size-3" />
            ))}
        </button>
      </TH>
    );
  };

  return (
    <Table>
      <THead>
        <TR>
          <TH>{t("columns.name")}</TH>
          {header("cpu", t("columns.cpu"))}
          {header("memory", t("columns.memory"))}
          {header("memoryPercent", t("columns.memoryPercent"))}
          {header("rx", t("columns.networkIn"))}
          {header("tx", t("columns.networkOut"))}
          <TH>{t("columns.trend")}</TH>
        </TR>
      </THead>
      <TBody>
        {groups.map((project) => (
          <Fragment key={project.projectName}>
            <TR>
              <TD className="font-medium">{project.projectName}</TD>
              <Readings totals={project.totals} />
              <TD />
            </TR>
            {project.services.map((service) => {
              const scope = `${service.projectName}/${service.serviceName}`;
              const trend = trends[scope] ?? [];
              return (
                <Fragment key={scope}>
                  <TR>
                    <TD className="pl-4">
                      <button
                        type="button"
                        className="flex items-center gap-2 font-mono text-xs hover:underline hover:underline-offset-4"
                        onClick={() => onSelect(service.projectName, service.serviceName)}
                      >
                        <Lamp state={stateOf(service.projectName, service.serviceName)} size="xs" still />
                        {service.serviceName}
                      </button>
                    </TD>
                    <Readings totals={service.totals} />
                    <TD>
                      <Sparkline
                        values={trend}
                        label={t("columns.trendOf", { service: service.serviceName })}
                        width={80}
                        height={20}
                      />
                    </TD>
                  </TR>
                  {service.tasks.map((task) => (
                    <TR key={task.taskId}>
                      <TD className={cn("pl-8 font-mono text-xs text-muted")}>
                        {`${service.serviceName}.${task.slot ?? task.taskId.slice(0, 12)}`}
                      </TD>
                      <Readings totals={sum([task])} />
                      <TD />
                    </TR>
                  ))}
                </Fragment>
              );
            })}
          </Fragment>
        ))}
      </TBody>
    </Table>
  );
}
