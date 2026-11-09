import type { ServiceDetail } from "@opsifier/contract";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, EmptyState, FormBanner, Lamp, Tooltip } from "../../ui";
import { useServiceParams } from "./api";
import { PendingChangesDialog } from "./tabs/deployments/PendingChanges";

/** One short word beside the state, with the sentence behind it. */
function Flag({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip content={hint}>
      <button type="button" className="inline-flex cursor-default rounded-sm">
        <Badge tone="busy">{label}</Badge>
      </button>
    </Tooltip>
  );
}

/**
 * Saved settings are not yet what runs. A still half-filled lamp: queued, but nothing is moving.
 * Opens the list of what the next deployment would change, from whichever tab this is on.
 */
function PendingFlag() {
  const { t } = useTranslation("services");
  const { project, service } = useServiceParams();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip content={t("flags.pendingHint")}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center rounded-sm border px-2 py-0.5 hover:bg-wash"
        >
          <Lamp state="progress" still label={t("flags.pending")} showLabel />
        </button>
      </Tooltip>
      <PendingChangesDialog open={open} onOpenChange={setOpen} project={project} service={service} />
    </>
  );
}

/** What a service's header adds when what runs isn't quite what was saved, or isn't proven to work. */
export function ServiceFlags({ detail }: { detail: ServiceDetail }) {
  const { t } = useTranslation("services");
  return (
    <>
      {detail.pendingChanges && <PendingFlag />}
      {detail.answering === false && detail.status === "running" && (
        <Flag label={t("flags.silent")} hint={t("flags.silentHint")} />
      )}
    </>
  );
}

/** Goes on every tab: it decides what can be done on this service, whichever tab that is on. */
export function RuntimeNotice({ detail }: { detail: ServiceDetail }) {
  const { t } = useTranslation("services");
  if (detail.runtimeUncertain === null || detail.activeAction !== null) {
    return null;
  }
  return (
    <FormBanner
      tone="warning"
      title={t(`notice.uncertain.${detail.runtimeUncertain}.title`)}
      className="mb-3"
    >
      {t(`notice.uncertain.${detail.runtimeUncertain}.description`)}
    </FormBanner>
  );
}

/** Says so, in pictures, when a service has nothing running to show. */
export function ServiceNotice({ detail }: { detail: ServiceDetail }) {
  const { t } = useTranslation("services");
  if (detail.activeAction !== null || (detail.status !== "stopped" && detail.status !== "undeployed")) {
    return null;
  }
  return (
    <section className="border-b px-4 py-6 md:px-6 lg:px-8">
      <EmptyState
        illustration={detail.status === "stopped" ? "service-stopped" : "no-deployments"}
        title={t(`notice.${detail.status}.title`)}
        description={t(`notice.${detail.status}.description`)}
      />
    </section>
  );
}
