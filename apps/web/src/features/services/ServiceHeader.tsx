import type { ServiceDetail } from "@opsifier/contract";
import { Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Lamp, PageHeader, Pictogram, type PictogramName, Tooltip, WakeStrip } from "../../ui";
import { MetricsRow } from "../service-runtime/MetricsRow";
import { RuntimeNotice, ServiceFlags } from "./ServiceNotice";
import { ReplicaPips } from "./ServiceRow";
import { servicePictogram, serviceState, serviceStateLabel, serviceTypeLabel } from "./serviceState";

/** The pictogram of each tab of a service or database page, by its key. */
const tabPictograms: Readonly<Record<string, PictogramName>> = {
  overview: "metrics",
  source: "git",
  deployments: "deployment",
  environment: "environment",
  domains: "domain",
  redirects: "redirect",
  scripts: "console",
  security: "access",
  resources: "cpu",
  maintenance: "maintenance",
  storage: "volume",
  advanced: "settings",
  backups: "backup",
  credentials: "access",
  expose: "port",
  modules: "box",
  processes: "activity",
  hooks: "webhook",
  ide: "editor",
};

export function TabPictogram({ tab }: { tab: string }) {
  const name = tabPictograms[tab];
  return name === undefined ? null : <Pictogram name={name} size={16} />;
}

/** The underlined tab of a service page, with its pictogram. */
export const tabLinkClass =
  "relative flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap text-sm text-muted after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:origin-left after:scale-x-0 after:bg-highlight after:transition-transform after:duration-[160ms] after:ease-out hover:text-ink data-[status=active]:font-medium data-[status=active]:text-ink data-[status=active]:after:scale-x-100";

export interface ServiceHeaderProps {
  project: string;
  service: string;
  detail: ServiceDetail;
  toolbar: ReactNode;
  /** The tab strip, under the readings. */
  tabs: ReactNode;
  onRename: () => void;
}

/** What a service is and how it is doing, before anyone reads a word: the frame of every service tab. */
export function ServiceHeader({ project, service, detail, toolbar, tabs, onRename }: ServiceHeaderProps) {
  const { t } = useTranslation(["services", "visual", "activity"]);
  const typeLabel = serviceTypeLabel(detail.type, t);

  return (
    <PageHeader
      leading={<Lamp state={serviceState(detail)} size="xl" decorative className="mt-1" />}
      title={
        <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span title={typeLabel} className="inline-flex text-muted">
            <Pictogram name={servicePictogram(detail.type)} size={24} label={typeLabel} />
          </span>
          <span className="font-mono">{service}</span>
          <Tooltip content={t("rename.open")}>
            <button
              type="button"
              aria-label={t("rename.open")}
              onClick={onRename}
              className="flex size-7 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
            >
              <Pencil aria-hidden="true" className="size-3.5" />
            </button>
          </Tooltip>
        </span>
      }
      description={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm font-medium text-ink">{serviceStateLabel(detail, t)}</span>
          <ReplicaPips {...detail.replicas} />
          <WakeStrip outcomes={detail.wake} label={t("rows.wakeLabel", { count: detail.wake.length })} />
          <ServiceFlags detail={detail} />
        </span>
      }
      actions={toolbar}
    >
      <RuntimeNotice detail={detail} />
      <MetricsRow key={`${project}/${service}`} project={project} service={service} />
      {tabs}
    </PageHeader>
  );
}
