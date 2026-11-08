import type { ServiceSummary } from "@opsifier/contract";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../lib/format";
import { Badge, StatusLamp, WakeStrip } from "../../ui";
import { servicePageLink } from "../databases/links";
import { lampForService, statusLabelKey } from "./api";

/** One ruled row: the lamp, the name, how many tasks are up, and the wake of past deployments. */
export function ServiceRow({ service }: { service: ServiceSummary }) {
  const { t, i18n } = useTranslation("services");
  const deployed = service.wake.length;
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b py-2.5 last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] sm:gap-x-5">
      <StatusLamp
        status={lampForService(service.status, service.activeAction)}
        label={t(statusLabelKey(service.status))}
      />
      <Link
        {...servicePageLink(service.projectName, service.name, service.type)}
        className="min-w-0 truncate font-mono text-sm hover:underline hover:underline-offset-4"
      >
        {service.name}
      </Link>
      <Badge mono className="justify-self-end sm:justify-self-auto">
        {service.type}
      </Badge>
      <span className="col-start-2 font-mono text-xs text-muted sm:col-auto" title={t("rows.replicasHint")}>
        {service.replicas.running}/{service.replicas.desired}
      </span>
      <span className="col-start-2 flex items-center gap-3 sm:col-auto">
        <WakeStrip outcomes={service.wake} label={t("rows.wakeLabel", { count: deployed })} />
        <span className="hidden w-28 text-right text-xs text-muted lg:inline">
          {service.lastDeployedAt === null
            ? t("rows.neverDeployed")
            : formatRelativeTime(service.lastDeployedAt, i18n.language)}
        </span>
      </span>
    </li>
  );
}
