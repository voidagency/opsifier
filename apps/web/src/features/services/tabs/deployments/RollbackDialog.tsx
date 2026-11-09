import type { ReleaseEntry } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../../../lib/forms";
import { ConfirmDialog, ErrorState, Lamp, MonoValue, Pictogram, Skeleton, toast } from "../../../../ui";
import { useActionFollower } from "../../ActionFollower";
import { releaseQuery, serviceKey, servicesApi } from "../../api";
import { ChangesTable } from "./ChangesTable";

function Fact({
  pictogram,
  label,
  children,
}: {
  pictogram: "image" | "settings" | "volume";
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <Pictogram name={pictogram} className="text-muted" />
        <span className="font-medium">{label}</span>
      </div>
      <div className="pl-7">{children}</div>
    </div>
  );
}

/** Shows what comes back and what stays, and needs the service's name typed before it goes ahead. */
export function RollbackDialog({
  project,
  service,
  release,
  onClose,
}: {
  project: string;
  service: string;
  release: ReleaseEntry | null;
  onClose: () => void;
}) {
  const { t } = useTranslation(["service-deployments", "common"]);
  const queryClient = useQueryClient();
  const follow = useActionFollower();
  const number = release?.number ?? 0;
  const { data, isPending, isError, error, refetch } = useQuery({
    ...releaseQuery(project, service, number),
    enabled: release !== null,
  });

  const confirm = async () => {
    const action = await servicesApi.rollback(project, service, number, service);
    follow(action.id, {
      success: () => toast.success(t("rollback.done", { number })),
      failure: (ended) => toast.error(t("rollback.failed", { number }), ended.error ?? undefined),
    });
    await queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
  };

  return (
    <ConfirmDialog
      open={release !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      size="lg"
      title={t("rollback.title", { number })}
      description={t("rollback.description")}
      confirmLabel={t("rollback.confirm")}
      confirmText={service}
      onConfirm={confirm}
    >
      {isPending ? (
        <Skeleton className="h-24" />
      ) : isError ? (
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      ) : (
        <div className="grid gap-4">
          <Fact pictogram="image" label={t("rollback.image")}>
            <div className="grid gap-0.5">
              <MonoValue value={data.image} className="break-all" />
              <span className="flex flex-wrap items-center gap-x-2 text-sm text-muted">
                <MonoValue value={data.digest ?? data.imageId} className="break-all" />
                {t("rollback.imageLocal")}
              </span>
            </div>
          </Fact>
          <Fact pictogram="settings" label={t("rollback.configuration")}>
            {data.changes.length === 0 ? (
              <span className="text-muted">{t("rollback.noChanges")}</span>
            ) : (
              <ChangesTable
                changes={data.changes}
                beforeLabel={t("changes.running")}
                afterLabel={t("rollback.after", { number })}
              />
            )}
          </Fact>
          <Fact pictogram="volume" label={t("rollback.data")}>
            <ul className="grid gap-1">
              <li className="flex items-start gap-2">
                <Lamp state="running" decorative className="mt-1" />
                {t("rollback.volumesStay")}
              </li>
              <li className="flex items-start gap-2">
                <Lamp state="running" decorative className="mt-1" />
                {t("rollback.savedStays")}
              </li>
              <li className="flex items-start gap-2">
                <Lamp state="degraded" decorative still className="mt-1" />
                {t("rollback.notUndone")}
              </li>
            </ul>
          </Fact>
        </div>
      )}
    </ConfirmDialog>
  );
}
