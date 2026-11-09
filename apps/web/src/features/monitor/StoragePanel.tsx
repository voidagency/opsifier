import type { StorageReport } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import {
  EmptyState,
  ErrorState,
  Gauge,
  GaugeBar,
  Pictogram,
  type PictogramName,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "../../ui";
import { storageQuery } from "./api";
import { KeptVolumes } from "./KeptVolumes";

type Column = "projectName" | "serviceName" | "sizeBytes" | "path";
type Sort = { column: Column; direction: "asc" | "desc" } | null;

function compare(
  a: StorageReport["services"][number],
  b: StorageReport["services"][number],
  column: Column,
): number {
  return column === "sizeBytes"
    ? (a.sizeBytes ?? -1) - (b.sizeBytes ?? -1)
    : a[column].localeCompare(b[column]);
}

function DiskGauge({
  label,
  used,
  total,
  path,
  unknown,
}: {
  label: string;
  used: number | null;
  total: number | null;
  path: string | null;
  unknown?: string;
}) {
  const reading = used !== null && total !== null && total > 0;
  return (
    <div className="flex items-center gap-4">
      <Gauge
        value={reading ? used : null}
        max={reading ? total : 100}
        size="md"
        label={label}
        valueText={`${formatBytes(used)} / ${formatBytes(total)}`}
      />
      <div className="min-w-0 text-sm">
        <p className="font-medium">{label}</p>
        {reading ? (
          <p className="font-mono text-xs text-muted">{`${formatBytes(used)} / ${formatBytes(total)}`}</p>
        ) : (
          unknown !== undefined && <p className="max-w-[28ch] text-xs text-muted">{unknown}</p>
        )}
        {path !== null && (
          <p className="mt-1 max-w-[28ch] truncate font-mono text-xs text-muted" title={path}>
            {path}
          </p>
        )}
      </div>
    </div>
  );
}

/** Docker's own disk beside the panel's, and what Docker keeps on it, by kind. */
function DockerUsage({ report }: { report: StorageReport }) {
  const { t } = useTranslation("monitor");
  const kinds: Array<{ pictogram: PictogramName; label: string; bytes: number | null }> = [
    { pictogram: "image", label: t("storage.images"), bytes: report.docker?.imagesBytes ?? null },
    {
      pictogram: "deployment",
      label: t("storage.containers"),
      bytes: report.docker?.containersBytes ?? null,
    },
    { pictogram: "volume", label: t("storage.volumes"), bytes: report.docker?.volumesBytes ?? null },
    { pictogram: "backup", label: t("storage.buildCache"), bytes: report.docker?.buildCacheBytes ?? null },
  ];
  // With Docker's disk out of reach, its usage is only drawn against itself, never against another disk.
  const scale =
    report.dockerDisk?.totalBytes ??
    Math.max(
      1,
      kinds.reduce((total, kind) => total + (kind.bytes ?? 0), 0),
    );
  return (
    <section aria-label={t("storage.docker")} className="grid gap-5 xl:grid-cols-[auto_minmax(0,1fr)]">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
        <DiskGauge
          label={t("storage.disk")}
          used={report.disk.usedBytes}
          total={report.disk.totalBytes}
          path={report.disk.path}
          unknown={t("gauges.noData")}
        />
        <DiskGauge
          label={t("storage.dockerDisk")}
          used={report.dockerDisk?.usedBytes ?? null}
          total={report.dockerDisk?.totalBytes ?? null}
          path={report.dockerDisk?.path ?? null}
          unknown={t("storage.dockerDiskUnknown")}
        />
      </div>
      <ul className="grid content-center gap-2">
        {kinds.map((kind) => (
          <li
            key={kind.label}
            className="grid grid-cols-[auto_8rem_minmax(0,1fr)] items-center gap-2 text-sm"
          >
            <Pictogram name={kind.pictogram} size={16} />
            <span className="truncate">{kind.label}</span>
            <GaugeBar
              value={kind.bytes}
              max={scale}
              label={kind.label}
              display={kind.bytes === null ? undefined : formatBytes(kind.bytes)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Where each service's data lives and how much of it there is, biggest first. */
export function StoragePanel() {
  const { t } = useTranslation(["monitor", "common"]);
  const { data, isPending, isError, error, refetch } = useQuery(storageQuery);
  const [sort, setSort] = useState<Sort>({ column: "sizeBytes", direction: "desc" });

  const rows = useMemo(() => {
    const services = [...(data?.services ?? [])];
    if (sort === null) {
      return services;
    }
    const direction = sort.direction === "asc" ? 1 : -1;
    return services.sort((a, b) => compare(a, b, sort.column) * direction);
  }, [data, sort]);

  if (isPending) {
    return <Skeleton className="h-40" />;
  }
  if (isError) {
    return <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />;
  }

  const largest = Math.max(1, ...rows.map((row) => row.sizeBytes ?? 0));
  const cycle = (column: Column) =>
    setSort((current) => {
      if (current?.column !== column) {
        return { column, direction: "asc" };
      }
      return current.direction === "asc" ? { column, direction: "desc" } : null;
    });
  const header = (column: Column, label: string, numeric = false) => {
    const active = sort?.column === column;
    return (
      <TH
        numeric={numeric}
        aria-sort={active ? (sort?.direction === "asc" ? "ascending" : "descending") : "none"}
      >
        <button
          type="button"
          className="inline-flex items-center gap-1 hover:text-ink"
          onClick={() => cycle(column)}
        >
          {label}
          {active &&
            (sort?.direction === "asc" ? (
              <ArrowUp aria-hidden="true" className="size-3" />
            ) : (
              <ArrowDown aria-hidden="true" className="size-3" />
            ))}
        </button>
      </TH>
    );
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <DockerUsage report={data} />
      <KeptVolumes />
      {rows.length === 0 ? (
        <EmptyState
          illustration="no-services"
          title={t("storage.emptyTitle")}
          description={t("storage.emptyDescription")}
        />
      ) : (
        <Table>
          <THead>
            <TR>
              {header("projectName", t("storage.project"))}
              {header("serviceName", t("storage.service"))}
              {header("sizeBytes", t("storage.size"))}
              {header("path", t("storage.path"))}
            </TR>
          </THead>
          <TBody>
            {rows.map((row) => (
              <TR key={`${row.projectName}/${row.serviceName}`}>
                <TD mono>{row.projectName}</TD>
                <TD mono>{row.serviceName}</TD>
                <TD className="w-56">
                  <GaugeBar
                    value={row.sizeBytes}
                    max={largest}
                    label={t("storage.size")}
                    display={row.sizeBytes === null ? undefined : formatBytes(row.sizeBytes)}
                  />
                </TD>
                <TD mono className="max-w-0 truncate text-muted" title={row.path}>
                  {row.path}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
