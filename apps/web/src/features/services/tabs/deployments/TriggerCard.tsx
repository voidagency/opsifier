import type { DeploymentWebhook, IssuedDeploymentWebhook } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../../../lib/format";
import { errorMessage } from "../../../../lib/forms";
import {
  Button,
  ConfirmDialog,
  CopyButton,
  Dialog,
  Field,
  FormBanner,
  Input,
  Lamp,
  MonoValue,
  SectionIntro,
  Skeleton,
  toast,
} from "../../../../ui";
import { servicesApi, triggerQuery, useServiceParams } from "../../api";

/** Everything here happens once: the value is on its way to the person and nowhere else. */
function ShownOnce({
  open,
  title,
  note,
  fields,
  doneLabel,
  onClose,
}: {
  open: boolean;
  title: string;
  note: string;
  fields: Array<{ label: string; value: string; copy: string; hint: string }>;
  doneLabel: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={title}
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          {doneLabel}
        </Button>
      }
    >
      <div className="grid gap-3">
        <FormBanner tone="success">{note}</FormBanner>
        {fields.map((field) => (
          <Field key={field.label} label={field.label} hint={field.hint}>
            <div className="flex items-center gap-2">
              <Input mono readOnly value={field.value} onFocus={(event) => event.currentTarget.select()} />
              <CopyButton value={field.value} label={field.copy} />
            </div>
          </Field>
        ))}
      </div>
    </Dialog>
  );
}

function WebhookStatus({ webhook }: { webhook: DeploymentWebhook }) {
  const { t } = useTranslation("service-deployments");
  return (
    <div className="grid gap-1">
      <Lamp
        state={webhook.paused ? "degraded" : "running"}
        label={webhook.paused ? t("webhook.paused") : t("webhook.active")}
        showLabel
      />
      <p className="text-sm text-muted">
        {t("webhook.bound", { repository: webhook.repository, ref: webhook.ref })}
      </p>
      {webhook.paused && <FormBanner tone="warning">{t("webhook.pausedHint")}</FormBanner>}
      {webhook.legacy && !webhook.paused && <FormBanner tone="warning">{t("webhook.legacy")}</FormBanner>}
      <MonoValue
        value={`${window.location.origin}${webhook.path}`}
        copy
        copyLabel={t("webhook.copyAddress")}
        truncate
        className="text-sm"
      />
    </div>
  );
}

/** How something outside the panel may start a deployment: a CI job with a token, a Git host with a webhook. */
export function TriggerCard() {
  const { t, i18n } = useTranslation(["service-deployments", "common"]);
  const { project, service } = useServiceParams();
  const queryClient = useQueryClient();
  const { data, isPending, isError, error } = useQuery({ ...triggerQuery(project, service), retry: false });
  const [busy, setBusy] = useState<"token" | "webhook" | null>(null);
  const [confirming, setConfirming] = useState<
    "rotate-token" | "revoke-token" | "rotate-webhook" | "remove-webhook" | null
  >(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [issuedHook, setIssuedHook] = useState<IssuedDeploymentWebhook | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: triggerQuery(project, service).queryKey });

  /** Each of these can fail at GitHub, and the card has to stay usable when one does. */
  const attempt = async (which: "token" | "webhook", work: () => Promise<void>) => {
    setBusy(which);
    setFailure(null);
    try {
      await work();
    } catch (cause) {
      setFailure(errorMessage(cause, t));
    } finally {
      setBusy(null);
    }
  };

  const issueToken = () =>
    attempt("token", async () => {
      const issued = await servicesApi.rotateTrigger(project, service);
      await refresh();
      setIssuedToken(issued.token);
      toast.success(t("trigger.generated"));
    });

  const revokeToken = () =>
    attempt("token", async () => {
      await servicesApi.revokeTrigger(project, service);
      await refresh();
      toast.success(t("trigger.revoked"));
    });

  const issueWebhook = (create: boolean) =>
    attempt("webhook", async () => {
      const issued = await servicesApi.rotateWebhook(project, service);
      await refresh();
      if (issued.secret !== null) {
        setIssuedHook(issued);
      }
      toast.success(t(create ? "webhook.created" : "webhook.rotated"));
    });

  const removeWebhook = () =>
    attempt("webhook", async () => {
      await servicesApi.removeWebhook(project, service);
      await refresh();
      toast.success(t("webhook.removed"));
    });

  if (isPending) {
    return <Skeleton className="h-24 max-w-[900px]" />;
  }
  if (isError) {
    return <FormBanner>{errorMessage(error, t)}</FormBanner>;
  }

  const endpoint = `${window.location.origin}${data.path}`;
  const command = `curl -X POST -H "Authorization: Bearer $TOKEN" ${endpoint}`;
  const { webhook } = data;
  const webhookOffer = webhook !== null || data.webhookAvailable;

  return (
    <section className="grid max-w-[900px] grid-cols-[minmax(0,1fr)] gap-5 border-t pt-5">
      <div className="grid gap-3">
        <SectionIntro pictogram="webhook" title={t("trigger.title")} description={t("trigger.description")} />
        {failure !== null && <FormBanner>{failure}</FormBanner>}
        {data.legacyUrl && <FormBanner tone="warning">{t("trigger.legacyUrl")}</FormBanner>}
        <Lamp
          state={data.hasToken ? "running" : "stopped"}
          label={data.hasToken ? t("trigger.tokenActive") : t("trigger.tokenNone")}
          showLabel
        />
        {data.createdAt !== null && (
          <p className="text-sm text-muted">
            {t("trigger.tokenIssuedAt", { when: formatRelativeTime(data.createdAt, i18n.language) })}
          </p>
        )}
        {data.hasToken && (
          <>
            <Field label={t("trigger.address")} hint={t("trigger.forceRebuildHint")}>
              <MonoValue
                value={endpoint}
                copy
                copyLabel={t("trigger.copyAddress")}
                truncate
                className="text-sm"
              />
            </Field>
            <Field label={t("trigger.example")} hint={t("trigger.exampleHint")}>
              <MonoValue
                value={command}
                copy
                copyLabel={t("trigger.copyExample")}
                truncate
                className="text-sm"
              />
            </Field>
          </>
        )}
        <div className="flex flex-wrap gap-2">
          {data.hasToken ? (
            <>
              <Button size="sm" pending={busy === "token"} onClick={() => setConfirming("rotate-token")}>
                {t("trigger.rotate")}
              </Button>
              <Button size="sm" onClick={() => setConfirming("revoke-token")}>
                {t("trigger.revoke")}
              </Button>
            </>
          ) : (
            <Button size="sm" pending={busy === "token"} onClick={issueToken}>
              {t("trigger.generate")}
            </Button>
          )}
        </div>
      </div>

      {webhookOffer && (
        <div className="grid gap-3 border-t pt-4">
          <SectionIntro
            pictogram="webhook"
            title={t("webhook.title")}
            description={t("webhook.description")}
          />
          {webhook === null ? (
            <Lamp state="stopped" label={t("webhook.none")} showLabel />
          ) : (
            <WebhookStatus webhook={webhook} />
          )}
          <div className="flex flex-wrap gap-2">
            {webhook === null ? (
              <Button size="sm" pending={busy === "webhook"} onClick={() => issueWebhook(true)}>
                {t("webhook.create")}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  pending={busy === "webhook"}
                  onClick={() => setConfirming("rotate-webhook")}
                >
                  {t("webhook.rotate")}
                </Button>
                <Button size="sm" onClick={() => setConfirming("remove-webhook")}>
                  {t("webhook.remove")}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirming === "rotate-token"}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t("trigger.rotateTitle")}
        description={t("trigger.rotateDescription")}
        confirmLabel={t("trigger.rotateConfirm")}
        tone="primary"
        onConfirm={issueToken}
      />
      <ConfirmDialog
        open={confirming === "revoke-token"}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t("trigger.revokeTitle")}
        description={t("trigger.revokeDescription")}
        confirmLabel={t("trigger.revokeConfirm")}
        onConfirm={revokeToken}
      />
      <ConfirmDialog
        open={confirming === "rotate-webhook"}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t("webhook.rotateTitle")}
        description={t("webhook.rotateDescription")}
        confirmLabel={t("webhook.rotateConfirm")}
        tone="primary"
        onConfirm={() => issueWebhook(false)}
      />
      <ConfirmDialog
        open={confirming === "remove-webhook"}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t("webhook.removeTitle")}
        description={t("webhook.removeDescription")}
        confirmLabel={t("webhook.removeConfirm")}
        onConfirm={removeWebhook}
      />
      <ShownOnce
        open={issuedToken !== null}
        title={t("trigger.tokenTitle")}
        note={t("trigger.tokenShownOnce")}
        fields={[
          {
            label: t("trigger.tokenLabel"),
            value: issuedToken ?? "",
            copy: t("trigger.copyToken"),
            hint: t("trigger.copyHint"),
          },
        ]}
        doneLabel={t("trigger.done")}
        onClose={() => setIssuedToken(null)}
      />
      <ShownOnce
        open={issuedHook !== null}
        title={t("webhook.issuedTitle")}
        note={t("webhook.shownOnce")}
        fields={[
          {
            label: t("webhook.addressLabel"),
            value: `${window.location.origin}${issuedHook?.webhook.path ?? ""}`,
            copy: t("webhook.copyAddress"),
            hint: t("trigger.copyHint"),
          },
          {
            label: t("webhook.secretLabel"),
            value: issuedHook?.secret ?? "",
            copy: t("webhook.copySecret"),
            hint: t("trigger.copyHint"),
          },
        ]}
        doneLabel={t("webhook.done")}
        onClose={() => setIssuedHook(null)}
      />
    </section>
  );
}
