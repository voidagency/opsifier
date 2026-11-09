import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../../../lib/forms";
import { Dialog, ErrorState, Lamp, SectionIntro, Skeleton } from "../../../../ui";
import { pendingChangesQuery } from "../../api";
import { ChangesTable } from "./ChangesTable";

/** What the next deployment would change, saved values side by side with what is really running. */
function PendingChangesBody({ project, service }: { project: string; service: string }) {
  const { t } = useTranslation(["service-deployments", "common"]);
  const { data, isPending, isError, error, refetch } = useQuery(pendingChangesQuery(project, service));

  if (isPending) {
    return <Skeleton className="h-16" />;
  }
  if (isError) {
    return <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />;
  }
  if (!data.known) {
    return <p className="text-muted">{t("pending.unknown")}</p>;
  }
  return (
    <div className="grid gap-3">
      {data.changes.length === 0 ? (
        <p className="flex items-center gap-2">
          <Lamp state="running" label={t("pending.none")} showLabel />
        </p>
      ) : (
        <ChangesTable
          changes={data.changes}
          beforeLabel={t("changes.running")}
          afterLabel={t("changes.saved")}
        />
      )}
      {data.refetches !== null && (
        <p className="text-sm text-muted">{t(`pending.refetches.${data.refetches}`)}</p>
      )}
    </div>
  );
}

/** Opened from the service header, so it can be asked on any tab. */
export function PendingChangesDialog({
  open,
  onOpenChange,
  project,
  service,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: string;
  service: string;
}) {
  const { t } = useTranslation("service-deployments");
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" title={t("pending.title")}>
      <PendingChangesBody project={project} service={service} />
    </Dialog>
  );
}

/** A section of the Deployments tab, there only while something is waiting. */
export function PendingChangesPanel({ project, service }: { project: string; service: string }) {
  const { t } = useTranslation("service-deployments");
  return (
    <section className="grid gap-3">
      <SectionIntro
        pictogram="deployment"
        title={t("pending.title")}
        description={t("pending.description")}
      />
      <PendingChangesBody project={project} service={service} />
    </section>
  );
}
