import type { ServiceSummary } from "@opsifier/contract";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { formatRelativeTime } from "../../lib/format";
import { GaugeBar, Lamp, Pictogram, Tooltip, WakeStrip } from "../../ui";
import { servicePageLink } from "../databases/links";
import { cpuReading, memoryReading, type ServiceResources, shareOfLimit } from "../service-runtime/resources";
import { servicePictogram, serviceState, serviceStateLabel, serviceTypeLabel } from "./serviceState";

/** How many tasks are up out of those wanted, as filled and hollow pips, with the figures beside them. */
export function ReplicaPips({ running, desired }: ServiceSummary["replicas"]) {
  const { t } = useTranslation("services");
  const pips = Math.max(running, desired);
  return (
    <span
      title={t("rows.replicasHint")}
      className="inline-flex items-center gap-1.5 font-mono text-xs text-muted"
    >
      {pips <= 8 && (
        <span aria-hidden="true" className="flex items-center gap-0.5">
          {Array.from({ length: pips }, (_, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: identical pips with no identity of their own
              key={index}
              className={cn(
                "block size-1.5 rounded-[1px] border border-muted",
                index < running && "bg-muted",
              )}
            />
          ))}
        </span>
      )}
      <span>
        {running}/{desired}
      </span>
    </span>
  );
}

/** CPU and memory against their limits, drawn small enough for a table row. */
export function ResourceMeter({
  serviceName,
  resources,
  className,
}: {
  serviceName: string;
  resources: ServiceResources | undefined;
  className?: string;
}) {
  const { t } = useTranslation("services");
  const meters = [
    { name: "cpu", label: `${serviceName}: ${t("metrics.cpu")}`, reading: cpuReading(resources, t) },
    { name: "memory", label: `${serviceName}: ${t("metrics.memory")}`, reading: memoryReading(resources, t) },
  ] as const;

  return (
    <span className={cn("flex w-[260px] shrink-0 items-center gap-2.5", className)}>
      {meters.map(({ name, label, reading }) => (
        <span key={name} className="flex min-w-0 flex-1 items-center gap-1 text-muted">
          <Pictogram name={name} size={16} />
          <GaugeBar
            value={reading.value}
            max={reading.max}
            label={label}
            showValue={false}
            display={shareOfLimit(reading)}
            valueText={reading.valueText}
            className="min-w-0!"
          />
        </span>
      ))}
    </span>
  );
}

/** A service as a small pictogram with its lamp in the corner, for places too tight for a row. */
export function ServiceChip({ service, link = false }: { service: ServiceSummary; link?: boolean }) {
  const { t } = useTranslation(["services", "visual", "activity"]);
  const name = `${service.name}: ${serviceStateLabel(service, t)}`;
  const className =
    "relative inline-flex size-7 shrink-0 items-center justify-center rounded-sm border text-muted";
  const body = (
    <>
      <Pictogram name={servicePictogram(service.type)} size={16} />
      <Lamp
        state={serviceState(service)}
        size="xs"
        still
        decorative
        className="absolute -right-1 -bottom-1 rounded-full bg-bg p-px"
      />
    </>
  );

  if (!link) {
    return (
      <span role="img" aria-label={name} title={name} className={className}>
        {body}
      </span>
    );
  }
  return (
    <Tooltip content={name}>
      <Link
        {...servicePageLink(service.projectName, service.name, service.type)}
        aria-label={name}
        className={cn(className, "hover:bg-wash hover:text-ink")}
      >
        {body}
      </Link>
    </Tooltip>
  );
}

/** One ruled row: lamp, type, name, resources, tasks and the wake of past deployments. */
export function ServiceRow({
  service,
  resources,
}: {
  service: ServiceSummary;
  resources?: ServiceResources | undefined;
}) {
  const { t, i18n } = useTranslation(["services", "visual", "activity"]);
  const typeLabel = serviceTypeLabel(service.type, t);

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b py-2.5 last:border-b-0">
      <Lamp state={serviceState(service)} label={serviceStateLabel(service, t)} />
      <span title={typeLabel} className="inline-flex text-muted">
        <Pictogram name={servicePictogram(service.type)} label={typeLabel} />
      </span>
      <Link
        {...servicePageLink(service.projectName, service.name, service.type)}
        className="min-w-0 flex-1 basis-20 truncate font-mono text-base hover:underline hover:underline-offset-4"
      >
        {service.name}
      </Link>
      <ResourceMeter serviceName={service.name} resources={resources} />
      <span className="flex w-full items-center gap-x-4 pl-14 md:w-auto md:pl-0">
        <span className="inline-flex md:w-20">
          <ReplicaPips {...service.replicas} />
        </span>
        <WakeStrip
          outcomes={service.wake}
          label={t("rows.wakeLabel", { count: service.wake.length })}
          className="ml-auto md:ml-0"
        />
        <span className="hidden w-32 text-right text-xs whitespace-nowrap text-muted lg:inline">
          {service.lastDeployedAt === null
            ? t("rows.neverDeployed")
            : formatRelativeTime(service.lastDeployedAt, i18n.language)}
        </span>
      </span>
    </li>
  );
}
