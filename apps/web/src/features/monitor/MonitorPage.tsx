import {
  type ServicesMetrics,
  servicesMetrics,
  servicesMetricsTopic,
  type TaskMetrics,
} from "@opsifier/contract";
import { Fragment, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { formatBytes, formatPercent } from "../../lib/format";
import { useTopic } from "../../lib/realtime";
import {
  EmptyState,
  FormBanner,
  InstrumentFigure,
  PageHeader,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "../../ui";

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

interface Totals {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

function sum(tasks: readonly TaskMetrics[]): Totals {
  return tasks.reduce(
    (total, task) => ({
      cpuPercent: total.cpuPercent + task.cpuPercent,
      memoryUsedBytes: total.memoryUsedBytes + task.memoryUsedBytes,
      memoryLimitBytes: Math.max(total.memoryLimitBytes, task.memoryLimitBytes),
      networkRxBytes: total.networkRxBytes + task.networkRxBytes,
      networkTxBytes: total.networkTxBytes + task.networkTxBytes,
    }),
    { cpuPercent: 0, memoryUsedBytes: 0, memoryLimitBytes: 0, networkRxBytes: 0, networkTxBytes: 0 },
  );
}

function Readings({ totals, percent }: { totals: Totals; percent: number }) {
  return (
    <>
      <TD mono numeric>
        {formatPercent(totals.cpuPercent)}
      </TD>
      <TD mono numeric>
        {formatBytes(totals.memoryUsedBytes)}
      </TD>
      <TD mono numeric>
        {formatPercent(percent)}
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

const memoryShare = (used: number, limit: number) => (limit > 0 ? (used / limit) * 100 : 0);

function TasksTable({ reading }: { reading: ServicesMetrics }) {
  const { t } = useTranslation("monitor");
  const projects = [...new Set(reading.services.map((service) => service.projectName))];

  return (
    <Table>
      <THead>
        <TR>
          <TH>{t("columns.name")}</TH>
          <TH numeric>{t("columns.cpu")}</TH>
          <TH numeric>{t("columns.memory")}</TH>
          <TH numeric>{t("columns.memoryPercent")}</TH>
          <TH numeric>{t("columns.networkIn")}</TH>
          <TH numeric>{t("columns.networkOut")}</TH>
        </TR>
      </THead>
      <TBody>
        {projects.map((projectName) => {
          const services = reading.services.filter((service) => service.projectName === projectName);
          const projectTotals = sum(services.flatMap((service) => service.tasks));
          return (
            <Fragment key={projectName}>
              <TR>
                <TD className="font-medium">{projectName}</TD>
                <Readings
                  totals={projectTotals}
                  percent={memoryShare(projectTotals.memoryUsedBytes, projectTotals.memoryLimitBytes)}
                />
              </TR>
              {services.map((service) => {
                const totals = sum(service.tasks);
                return (
                  <Fragment key={service.serviceName}>
                    <TR>
                      <TD className="pl-4 font-mono text-xs">{service.serviceName}</TD>
                      <Readings
                        totals={totals}
                        percent={memoryShare(totals.memoryUsedBytes, totals.memoryLimitBytes)}
                      />
                    </TR>
                    {service.tasks.map((task) => (
                      <TR key={task.taskId}>
                        <TD className={cn("pl-8 font-mono text-xs text-muted")}>
                          {`${service.serviceName}.${task.slot ?? task.taskId.slice(0, 12)}`}
                        </TD>
                        <Readings totals={sum([task])} percent={task.memoryPercent} />
                      </TR>
                    ))}
                  </Fragment>
                );
              })}
            </Fragment>
          );
        })}
      </TBody>
    </Table>
  );
}

/** What every task on the server is using. Sampled only while this page is open and on screen. */
export function MonitorPage() {
  const { t } = useTranslation("monitor");
  const [reading, setReading] = useState<ServicesMetrics | null>(null);
  const visible = usePageVisible();

  useTopic<ServicesMetrics>(visible ? servicesMetricsTopic : null, (payload) => {
    const sample = servicesMetrics.safeParse(payload).data;
    if (sample !== undefined) {
      setReading(sample);
    }
  });

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="grid gap-4 px-4 py-6 md:px-6 lg:px-8">
        <h2 className="eyebrow">{t("services")}</h2>
        {reading === null ? (
          <Skeleton className="h-24 max-w-[960px]" />
        ) : !reading.available ? (
          <FormBanner className="max-w-[720px]">{t("unavailable")}</FormBanner>
        ) : reading.services.length === 0 ? (
          <EmptyState
            figure={<InstrumentFigure />}
            title={t("empty.title")}
            description={t("empty.description")}
          />
        ) : (
          <div className="max-w-[960px]">
            <TasksTable reading={reading} />
          </div>
        )}
      </div>
    </>
  );
}
