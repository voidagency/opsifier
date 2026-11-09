import type { Certificate, CertificateState } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "../../../lib/format";
import { errorMessage } from "../../../lib/forms";
import {
  Button,
  ConfirmDialog,
  countStates,
  EmptyState,
  ErrorState,
  GaugeBar,
  HealthSummary,
  Lamp,
  MonoValue,
  Pictogram,
  Skeleton,
  Tooltip,
  toast,
  type VisualState,
} from "../../../ui";
import { certificatesApi, certificatesQuery } from "./api";

const certStates: Record<CertificateState, VisualState> = {
  valid: "running",
  expiring: "degraded",
  expired: "failed",
  unreadable: "unknown",
};

const DAY_MS = 86_400_000;
/** The longest a certificate from Let's Encrypt lasts. */
const FULL_LIFE_DAYS = 90;

function daysLeft(certificate: Certificate): number | null {
  return certificate.notAfter === null
    ? null
    : Math.max(0, (Date.parse(certificate.notAfter) - Date.now()) / DAY_MS);
}

function CertificateRow({ certificate, onRemove }: { certificate: Certificate; onRemove: () => void }) {
  const { t, i18n } = useTranslation("settings-certificates");
  const left = daysLeft(certificate);
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b py-2.5 last:border-b-0">
      <span className="inline-flex items-center gap-1.5 text-muted">
        <Pictogram name="certificate" size={16} />
        <Lamp state={certStates[certificate.state]} label={t(`state.${certificate.state}`)} />
      </span>
      <div className="grid min-w-0 gap-1 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center sm:gap-4">
        <div className="min-w-0">
          <MonoValue value={certificate.domain} className="block truncate text-sm" />
          <p className="truncate text-xs text-muted">
            {certificate.issuer ?? t("unknownIssuer")} · {certificate.resolver}
            {certificate.sans.length > 0 ? ` · ${certificate.sans.join(", ")}` : ""}
          </p>
        </div>
        <GaugeBar
          value={left}
          max={FULL_LIFE_DAYS}
          thresholds={{ busy: 0.33, bad: 0.11 }}
          label={t("expiry")}
          display={
            certificate.notAfter === null ? undefined : formatDateTime(certificate.notAfter, i18n.language)
          }
        />
      </div>
      <Tooltip content={t("remove")}>
        <Button size="icon" variant="ghost" aria-label={t("remove")} onClick={onRemove}>
          <Trash2 aria-hidden="true" className="size-4" />
        </Button>
      </Tooltip>
    </li>
  );
}

/** What the proxy actually holds. There is no way to make one here: it asks for them by itself. */
export function CertificatesPage() {
  const { t } = useTranslation(["settings-certificates", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(certificatesQuery);
  const [filter, setFilter] = useState<VisualState | null>(null);
  const [removing, setRemoving] = useState<Certificate | null>(null);

  const certificates = data?.certificates ?? [];
  const counts = useMemo(
    () => countStates(certificates.map((item) => certStates[item.state])),
    [certificates],
  );
  const shown =
    filter === null ? certificates : certificates.filter((item) => certStates[item.state] === filter);

  const remove = async () => {
    if (removing === null) {
      return false;
    }
    await certificatesApi.remove(removing.id, removing.domain);
    await queryClient.invalidateQueries({ queryKey: ["certificates"] });
    toast.success(t("removed"));
    return true;
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 px-4 py-6 md:px-6 lg:px-8">
      <div>
        <h2 className="text-md font-medium">{t("title")}</h2>
        <p className="mt-1 max-w-[60ch] text-sm text-muted">{t("description")}</p>
      </div>
      {isPending ? (
        <Skeleton className="h-24" />
      ) : isError ? (
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      ) : certificates.length === 0 ? (
        <EmptyState illustration="no-domains" title={t("emptyTitle")} description={t("emptyDescription")} />
      ) : (
        <>
          <HealthSummary counts={counts} selected={filter} onSelect={setFilter} />
          <ul className="border-t">
            {shown.map((certificate) => (
              <CertificateRow
                key={certificate.id}
                certificate={certificate}
                onRemove={() => setRemoving(certificate)}
              />
            ))}
          </ul>
        </>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("removeTitle")}
        description={t("removeDescription")}
        confirmLabel={t("remove")}
        confirmText={removing?.domain}
        onConfirm={remove}
      />
    </div>
  );
}
