import {
  type OpsifierAddressCertificateState,
  type OpsifierAddressState,
  type OpsifierAddressStatus,
  requestOpsifierAddressRequest,
} from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime, formatRelativeTime } from "../../lib/format";
import { errorMessage, useForm } from "../../lib/forms";
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormBanner,
  Input,
  Lamp,
  MonoValue,
  SectionIntro,
  Skeleton,
  Textarea,
  Tooltip,
  toast,
  type VisualState,
} from "../../ui";
import { useCurrentUser } from "../auth/session";
import { addressApi, addressKey, addressQuery } from "./api";

const statusStates: Record<OpsifierAddressStatus, VisualState> = {
  active: "running",
  unreachable: "degraded",
  lost: "failed",
  disabled: "failed",
  requested: "progress",
  refused: "failed",
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
  onRelease,
}: {
  state: OpsifierAddressState;
  domain: string;
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
        <Button variant="danger" onClick={onRelease} className="shrink-0">
          {t("release")}
        </Button>
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

function RequestedAddress({
  state,
  domain,
  onWithdraw,
}: {
  state: OpsifierAddressState;
  domain: string;
  onWithdraw: () => void;
}) {
  const { t, i18n } = useTranslation("settings-address");
  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b pb-5">
        <div className="flex min-w-0 items-center gap-3">
          <Lamp state={statusStates[state.status]} size="lg" label={t(`status.${state.status}`)} />
          <div className="min-w-0">
            <MonoValue value={domain} className="text-md font-medium" />
            <p className="text-sm text-muted">{t(`status.${state.status}`)}</p>
          </div>
        </div>
        <Button onClick={onWithdraw} className="shrink-0">
          {t("waiting.withdraw")}
        </Button>
      </header>
      <FormBanner tone="info">{t("waiting.hint", { panel: `panel.${domain}` })}</FormBanner>
      {state.requestedAt !== null && (
        <dl className="divide-y">
          <Fact label={t("waiting.asked")}>
            <time
              className="text-sm"
              dateTime={state.requestedAt}
              title={formatDateTime(state.requestedAt, i18n.language)}
            >
              {formatRelativeTime(state.requestedAt, i18n.language)}
            </time>
          </Fact>
        </dl>
      )}
    </>
  );
}

function RequestDialog({
  open,
  onOpenChange,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: (next: OpsifierAddressState) => Promise<void>;
}) {
  const { t } = useTranslation(["settings-address", "common"]);
  const email = useCurrentUser()?.email ?? "";
  const form = useForm({
    t,
    initialValues: { email, purpose: "" },
    validate: (values) => {
      const parsed = requestOpsifierAddressRequest.safeParse(values);
      const invalid = (field: string) =>
        !parsed.success && parsed.error.issues.some((issue) => issue.path[0] === field);
      return {
        ...(invalid("email") ? { email: t("requestForm.emailInvalid") } : {}),
        ...(invalid("purpose") ? { purpose: t("requestForm.purposeInvalid") } : {}),
      };
    },
    onSubmit: async (values) => {
      await onSent(await addressApi.request(values));
      toast.success(t("requestForm.sent"));
      onOpenChange(false);
      form.reset({ email: values.email, purpose: "" });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("requestForm.title")}
      description={t("requestForm.description")}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("requestForm.submit")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("requestForm.email")} hint={t("requestForm.emailHint")} error={form.errors.email}>
          <Input {...form.field("email")} type="email" autoComplete="email" />
        </Field>
        <Field
          label={t("requestForm.purpose")}
          hint={t("requestForm.purposeHint")}
          error={form.errors.purpose}
        >
          <Textarea {...form.field("purpose")} rows={3} maxLength={500} autoFocus />
        </Field>
      </div>
    </Dialog>
  );
}

export function AddressPage() {
  const { t } = useTranslation(["settings-address", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(addressQuery);
  const [requesting, setRequesting] = useState(false);
  const [asking, setAsking] = useState<"withdraw" | "release" | null>(null);
  const [moved, setMoved] = useState<string | null>(null);

  const refresh = async (next: OpsifierAddressState) => {
    queryClient.setQueryData(addressKey, next);
    await queryClient.invalidateQueries({ queryKey: ["server"] });
  };

  const withdraw = async () => {
    await refresh(await addressApi.withdraw());
    toast.success(t("waiting.withdrawn"));
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
          {data.status === "refused" && <FormBanner tone="error">{t("refusedNote")}</FormBanner>}
          {data.domain === null ? (
            <EmptyState
              illustration="no-domains"
              title={t("emptyTitle")}
              description={t(data.available ? "emptyDescription" : "emptyDescriptionOff")}
              action={
                data.available && (
                  <Button variant="primary" onClick={() => setRequesting(true)}>
                    {t("requestAction")}
                  </Button>
                )
              }
            />
          ) : data.status === "requested" ? (
            <RequestedAddress state={data} domain={data.domain} onWithdraw={() => setAsking("withdraw")} />
          ) : (
            <RegisteredAddress state={data} domain={data.domain} onRelease={() => setAsking("release")} />
          )}
        </>
      )}
      <RequestDialog open={requesting} onOpenChange={setRequesting} onSent={refresh} />
      <ConfirmDialog
        open={asking === "withdraw"}
        onOpenChange={(open) => !open && setAsking(null)}
        title={t("waiting.withdrawTitle")}
        description={t("waiting.withdrawDescription")}
        confirmLabel={t("waiting.withdraw")}
        onConfirm={withdraw}
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
