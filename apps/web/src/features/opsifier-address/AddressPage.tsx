import type {
  OpsifierAddressCertificateState,
  OpsifierAddressState,
  OpsifierAddressStatus,
} from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime, formatRelativeTime } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FormBanner,
  Lamp,
  MonoValue,
  SectionIntro,
  Skeleton,
  Tooltip,
  toast,
  type VisualState,
} from "../../ui";
import { addressApi, addressKey, addressQuery } from "./api";

const statusStates: Record<OpsifierAddressStatus, VisualState> = {
  active: "running",
  unreachable: "degraded",
  lost: "failed",
  disabled: "failed",
  off: "stopped",
};

const certificateStates: Record<OpsifierAddressCertificateState, VisualState> = {
  issued: "running",
  expiring: "degraded",
  expired: "failed",
  pending: "progress",
};

/** Only the states someone has to do something about say anything beyond their lamp. */
const problems = {
  unreachable: "warning",
  lost: "error",
  disabled: "error",
} as const;

const hasProblem = (status: OpsifierAddressStatus): status is keyof typeof problems => status in problems;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 py-2.5 sm:grid-cols-[11rem_minmax(0,1fr)]">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function RegisteredAddress({
  state,
  domain,
  onRegister,
  onRelease,
}: {
  state: OpsifierAddressState;
  domain: string;
  onRegister: () => void;
  onRelease: () => void;
}) {
  const { t, i18n } = useTranslation("settings-address");
  const certificate = state.certificate ?? "pending";
  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b pb-5">
        <div className="flex min-w-0 items-center gap-3">
          <Lamp state={statusStates[state.status]} size="lg" label={t(`status.${state.status}`)} />
          <div className="min-w-0">
            <MonoValue value={domain} copy copyLabel={t("copyAddress")} className="text-md font-medium" />
            <p className="text-sm text-muted">{t(`status.${state.status}`)}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button onClick={onRegister}>{t("registerAgain")}</Button>
          <Button variant="danger" onClick={onRelease}>
            {t("release")}
          </Button>
        </div>
      </header>

      {hasProblem(state.status) && (
        <FormBanner tone={problems[state.status]}>{t(`problem.${state.status}`)}</FormBanner>
      )}

      <dl className="divide-y">
        <Fact label={t("panel")}>
          {state.panelUrl !== null && (
            <a
              href={state.panelUrl}
              className="block truncate font-mono text-sm underline-offset-4 hover:underline"
              rel="noreferrer"
            >
              {state.panelUrl}
            </a>
          )}
        </Fact>
        <Fact label={t("certificate")}>
          <Tooltip content={t(`certificateHint.${certificate}`)}>
            <button type="button" className="inline-flex max-w-full cursor-default items-center gap-2">
              <Lamp state={certificateStates[certificate]} label={t(`certificateState.${certificate}`)} />
              <MonoValue value={state.wildcard ?? ""} truncate className="min-w-0 text-sm" />
            </button>
          </Tooltip>
        </Fact>
        <Fact label={t("ip")}>
          <MonoValue value={state.ip ?? t("unknownIp")} className="text-sm" />
        </Fact>
        <Fact label={t("lastCheck")}>
          {state.lastHeartbeatAt === null ? (
            <span className="text-sm text-muted">{t("never")}</span>
          ) : (
            <time
              className="text-sm"
              dateTime={state.lastHeartbeatAt}
              title={formatDateTime(state.lastHeartbeatAt, i18n.language)}
            >
              {formatRelativeTime(state.lastHeartbeatAt, i18n.language)}
            </time>
          )}
        </Fact>
      </dl>
    </>
  );
}

export function AddressPage() {
  const { t } = useTranslation(["settings-address", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(addressQuery);
  const [registering, setRegistering] = useState(false);
  const [asking, setAsking] = useState<"register" | "release" | null>(null);
  const [moved, setMoved] = useState<string | null>(null);

  const refresh = async (next: OpsifierAddressState) => {
    queryClient.setQueryData(addressKey, next);
    await queryClient.invalidateQueries({ queryKey: ["server"] });
  };

  const register = async () => {
    setRegistering(true);
    try {
      const next = await addressApi.register();
      await refresh(next);
      setMoved(next.panelUrl);
      toast.success(t("registered", { domain: next.domain ?? "" }));
    } catch (failure) {
      toast.error(errorMessage(failure, t));
    } finally {
      setRegistering(false);
    }
  };

  const release = async () => {
    if (data?.domain == null) {
      return;
    }
    const next = await addressApi.release(data.domain);
    await refresh(next);
    setMoved(next.panelUrl);
    toast.success(t("released"));
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 px-4 py-6 md:px-6 lg:px-8">
      <SectionIntro pictogram="domain" title={t("title")} description={t("description")} />
      {isPending ? (
        <Skeleton className="h-32" />
      ) : isError ? (
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      ) : (
        <>
          {moved !== null && (
            <FormBanner tone="info">
              {t("movedTo")} <MonoValue value={moved} copy copyLabel={t("copyAddress")} />
            </FormBanner>
          )}
          {data.domain === null ? (
            <EmptyState
              illustration="no-domains"
              title={t("emptyTitle")}
              description={t(data.available ? "emptyDescription" : "emptyDescriptionOff")}
              action={
                data.available && (
                  <Button variant="primary" pending={registering} onClick={register}>
                    {t("register")}
                  </Button>
                )
              }
            />
          ) : (
            <RegisteredAddress
              state={data}
              domain={data.domain}
              onRegister={() => setAsking("register")}
              onRelease={() => setAsking("release")}
            />
          )}
        </>
      )}
      <ConfirmDialog
        open={asking === "register"}
        onOpenChange={(open) => !open && setAsking(null)}
        title={t("registerAgainTitle")}
        description={t("registerAgainDescription")}
        confirmLabel={t("registerAgain")}
        tone="primary"
        onConfirm={register}
      />
      <ConfirmDialog
        open={asking === "release"}
        onOpenChange={(open) => !open && setAsking(null)}
        title={t("releaseTitle")}
        description={t("releaseDescription")}
        confirmLabel={t("release")}
        confirmText={data?.domain ?? undefined}
        onConfirm={release}
      />
    </div>
  );
}
