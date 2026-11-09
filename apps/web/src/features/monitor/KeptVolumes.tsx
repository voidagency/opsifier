import type { RetainedVolume } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import {
  Button,
  ConfirmDialog,
  ErrorState,
  MonoValue,
  Pictogram,
  type PictogramName,
  RetentionSummary,
  SectionIntro,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  toast,
} from "../../ui";
import { retainedVolumesApi, retainedVolumesQuery } from "./api";

const kindPictograms: Record<RetainedVolume["kind"], PictogramName> = {
  app: "volume",
  database: "postgres",
  compose: "compose",
};

/** What destroyed services left behind. Deleting one of these is the only way a kept volume goes. */
export function KeptVolumes() {
  const { t, i18n } = useTranslation(["monitor", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(retainedVolumesQuery);
  const [deleting, setDeleting] = useState<RetainedVolume | null>(null);

  const confirmDelete = async () => {
    if (deleting === null) {
      return;
    }
    await retainedVolumesApi.delete(deleting.name);
    toast({ title: t("kept.deleting", { name: deleting.name }) });
    await queryClient.invalidateQueries({ queryKey: retainedVolumesQuery.queryKey });
  };

  return (
    <section aria-label={t("kept.title")} className="grid gap-3">
      <SectionIntro pictogram="volume" title={t("kept.title")} description={t("kept.description")} />
      {isPending ? (
        <Skeleton className="h-16" />
      ) : isError ? (
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      ) : data.volumes.length === 0 ? (
        <p className="text-sm text-muted">{t("kept.empty")}</p>
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>{t("kept.volume")}</TH>
              <TH>{t("kept.from")}</TH>
              <TH>{t("kept.since")}</TH>
              <TH />
            </TR>
          </THead>
          <TBody>
            {data.volumes.map((volume) => (
              <TR key={volume.name}>
                <TD mono>
                  <span className="inline-flex items-center gap-2">
                    <Pictogram name={kindPictograms[volume.kind]} size={16} className="text-muted" />
                    {volume.name}
                  </span>
                </TD>
                <TD mono>{`${volume.projectName} / ${volume.serviceName}`}</TD>
                <TD className="text-muted">{formatRelativeTime(volume.retainedAt, i18n.language)}</TD>
                <TD className="text-right">
                  <Button size="sm" onClick={() => setDeleting(volume)}>
                    {t("kept.delete")}
                  </Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("kept.deleteTitle")}
        description={
          deleting !== null && (
            <>
              {t("kept.deleteDescription")}{" "}
              <MonoValue value={deleting.name} copy copyLabel={t("kept.copyName")} />
            </>
          )
        }
        confirmLabel={t("kept.deleteConfirm")}
        confirmText={deleting?.name}
        onConfirm={confirmDelete}
      >
        <RetentionSummary removed={t("kept.removed")} kept={t("kept.keptStill")} />
      </ConfirmDialog>
    </section>
  );
}
