import { BOX_IDE_TOKEN_LIFETIME_HOURS, type BoxIdeAccess, type IssuedBoxIdeToken } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, KeyRound, RotateCw, ShieldOff } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../../../lib/format";
import { errorMessage } from "../../../../lib/forms";
import {
  Button,
  buttonClass,
  ConfirmDialog,
  CopyButton,
  Dialog,
  ErrorState,
  Field,
  FormBanner,
  Lamp,
  SectionIntro,
  Select,
  Skeleton,
  Switch,
  toast,
  type VisualState,
} from "../../../../ui";
import { boxApi, boxIdeQuery } from "../../../box/api";
import { serviceKey, useServiceParams } from "../../api";

const lampOf: Record<BoxIdeAccess, VisualState> = {
  open: "running",
  expired: "failed",
  no_token: "stopped",
  off: "stopped",
};

const LIFETIMES = [1, 24, 24 * 7, 24 * 30, BOX_IDE_TOKEN_LIFETIME_HOURS.max];

/** Who can get in, how, and for how long, all in one place. */
export function BoxIdeTab() {
  const { t, i18n } = useTranslation(["service-box-ide", "common"]);
  const { project, service } = useServiceParams();
  const queryClient = useQueryClient();
  const query = useQuery(boxIdeQuery(project, service));
  const [hours, setHours] = useState<number>(BOX_IDE_TOKEN_LIFETIME_HOURS.default);
  const [issued, setIssued] = useState<IssuedBoxIdeToken | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [rotating, setRotating] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });

  if (query.isPending) {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <ErrorState message={errorMessage(query.error, t)} onRetry={() => query.refetch()} />
      </div>
    );
  }

  const status = query.data;
  const hasToken = status.createdAt !== null;

  const setEnabled = async (enabled: boolean) => {
    setSwitching(true);
    try {
      await boxApi.setIde(project, service, enabled);
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error, t));
    } finally {
      setSwitching(false);
    }
  };

  const rotate = async () => {
    setRotating(true);
    try {
      setIssued(await boxApi.issueIdeToken(project, service, { expiresInHours: hours }));
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error, t));
    } finally {
      setRotating(false);
    }
  };

  return (
    <div className="grid max-w-[850px] gap-6 px-4 py-6 md:px-6 lg:px-8">
      <section className="grid gap-3">
        <SectionIntro pictogram="editor" title={t("title")} description={t("description")} />
        <div className="flex flex-wrap items-center gap-3">
          <Lamp state={lampOf[status.access]} size="lg" decorative />
          <div className="min-w-0">
            <p className="text-md font-medium">{t(`access.${status.access}.title`)}</p>
            <p className="text-sm text-muted">{t(`access.${status.access}.body`)}</p>
          </div>
        </div>
        <Switch
          label={t("enable")}
          hint={t("enableHint")}
          checked={status.enabled}
          disabled={switching}
          onCheckedChange={setEnabled}
        />
      </section>

      {status.enabled && (
        <section className="grid gap-3 border-t pt-6">
          <SectionIntro pictogram="access" title={t("token.title")} description={t("token.description")} />
          {hasToken && status.expiresAt !== null && (
            <p className="text-sm text-muted">
              {t("token.expires", { when: formatRelativeTime(status.expiresAt, i18n.language) })}
            </p>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t("token.lifetime")} hint={t("token.lifetimeHint")} className="w-64">
              <Select
                value={String(hours)}
                onValueChange={(value) => setHours(Number(value))}
                aria-label={t("token.lifetime")}
                options={LIFETIMES.map((value) => ({
                  value: String(value),
                  label: t(`token.lifetimes.${value}`),
                }))}
              />
            </Field>
            <Button
              variant="primary"
              icon={
                hasToken ? (
                  <RotateCw aria-hidden="true" className="size-4" />
                ) : (
                  <KeyRound aria-hidden="true" className="size-4" />
                )
              }
              pending={rotating}
              onClick={rotate}
            >
              {hasToken ? t("token.rotate") : t("token.issue")}
            </Button>
            {hasToken && (
              <Button
                icon={<ShieldOff aria-hidden="true" className="size-4" />}
                onClick={() => setRevoking(true)}
              >
                {t("token.revoke")}
              </Button>
            )}
          </div>
          {status.access === "open" && (
            <p>
              <a
                href={status.path}
                target="_blank"
                rel="noreferrer noopener"
                className={buttonClass("secondary", "md")}
              >
                <ExternalLink aria-hidden="true" className="size-4" />
                {t("open")}
              </a>
            </p>
          )}
        </section>
      )}

      <section className="border-t pt-6 text-sm text-muted">
        <p>{t("confinement")}</p>
      </section>

      <Dialog
        open={issued !== null}
        onOpenChange={(open) => {
          if (!open) {
            setIssued(null);
          }
        }}
        title={t("issued.title")}
        description={t("issued.description")}
        footer={
          <Button variant="primary" onClick={() => setIssued(null)}>
            {t("issued.done")}
          </Button>
        }
      >
        {issued !== null && (
          <div className="grid gap-3">
            <FormBanner tone="warning">{t("issued.warning")}</FormBanner>
            <div className="flex items-center gap-2 rounded-sm border bg-wash p-2.5">
              <code className="min-w-0 flex-1 break-all font-mono">{issued.token}</code>
              <CopyButton value={issued.token} label={t("issued.copy")} />
            </div>
            <a
              href={`${issued.path}#token=${issued.token}`}
              target="_blank"
              rel="noreferrer noopener"
              className={buttonClass("primary", "md")}
            >
              <ExternalLink aria-hidden="true" className="size-4" />
              {t("issued.open")}
            </a>
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        title={t("revoke.title")}
        description={t("revoke.description")}
        confirmLabel={t("revoke.confirm")}
        onConfirm={async () => {
          await boxApi.revokeIdeToken(project, service);
          await refresh();
          setRevoking(false);
        }}
      />
    </div>
  );
}
