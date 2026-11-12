import { INVITATION_DAYS, type Invitation } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../../../lib/format";
import { errorMessage, useForm } from "../../../../lib/forms";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  ErrorState,
  FormBanner,
  Lamp,
  MonoValue,
  Skeleton,
  Tooltip,
  toast,
  type VisualState,
} from "../../../../ui";
import { invitationsApi, invitationsQuery, mailLanguage } from "./api";
import { chosenChannel, DeliveryField, useMailChannels } from "./delivery";
import { LinkField } from "./InviteDialog";

/** Where an invitation stands, in the state language: a link nobody can vouch for reads as unknown. */
function stateOf(invitation: Invitation): VisualState {
  if (invitation.expired) {
    return "stopped";
  }
  switch (invitation.delivery) {
    case "failed":
      return "failed";
    case "sending":
      return "progress";
    case "sent":
      return "running";
    default:
      return "unknown";
  }
}

function ResendDialog({ invitation, onClose }: { invitation: Invitation | null; onClose: () => void }) {
  const { t, i18n } = useTranslation(["settings-access", "common"]);
  const queryClient = useQueryClient();
  const channels = useMailChannels(invitation !== null);
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const [link, setLink] = useState<string | null>(null);
  const channel = chosenChannel(picked, channels);

  const form = useForm({
    t,
    initialValues: {},
    onSubmit: async () => {
      if (invitation === null) {
        return;
      }
      const resent = await invitationsApi.resend(invitation.id, {
        channel,
        language: mailLanguage(i18n.language),
      });
      await queryClient.invalidateQueries({ queryKey: ["invitations"] });
      if (resent.link === null) {
        toast.success(t("invitations.resent", { email: invitation.email }));
        onClose();
      } else {
        setLink(resent.link);
      }
    },
  });
  const { reset } = form;

  useEffect(() => {
    if (invitation !== null) {
      reset({});
      setPicked(undefined);
      setLink(null);
    }
  }, [invitation, reset]);

  return (
    <Dialog
      open={invitation !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t("invitations.resendTitle")}
      description={t("invitations.resendDescription", {
        email: invitation?.email ?? "",
        days: INVITATION_DAYS,
      })}
      onSubmit={link === null ? form.handleSubmit : undefined}
      footer={
        link === null ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" variant="primary" pending={form.pending}>
              {t("invitations.resend")}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            {t("invitations.done")}
          </Button>
        )
      }
    >
      {link === null ? (
        <div className="grid gap-4">
          {form.banner && <FormBanner>{form.banner}</FormBanner>}
          <DeliveryField value={channel} onChange={setPicked} channels={channels} />
        </div>
      ) : (
        <div className="grid gap-3">
          <FormBanner tone="warning">{t("invitations.linkWarning")}</FormBanner>
          <LinkField label={t("invitations.linkFor", { email: invitation?.email ?? "" })} link={link} />
        </div>
      )}
    </Dialog>
  );
}

function InvitationRow({
  invitation,
  onResend,
  onRevoke,
}: {
  invitation: Invitation;
  onResend: () => void;
  onRevoke: () => void;
}) {
  const { t, i18n } = useTranslation("settings-access");
  const when = (iso: string) => formatRelativeTime(iso, i18n.language);
  const status = invitation.expired
    ? t("invitations.states.expired")
    : t(`invitations.states.${invitation.delivery}`, { channel: invitation.channelName ?? "" });
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b py-2.5 last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <Lamp state={stateOf(invitation)} label={status} still />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2">
          <MonoValue value={invitation.email} className="truncate text-sm" />
          <Badge tone={invitation.role === "admin" ? "accent" : "neutral"}>
            {t(`users.roles.${invitation.role}`)}
          </Badge>
          <span className="text-sm text-muted">{status}</span>
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {invitation.role === "admin"
            ? t("users.everyProject")
            : t("users.projectCount", { count: invitation.projects.length })}
          {" · "}
          {t("invitations.invitedBy", { email: invitation.invitedBy })}
          {" · "}
          {invitation.expired
            ? t("invitations.expiredWhen", { when: when(invitation.expiresAt) })
            : t("invitations.expiresWhen", { when: when(invitation.expiresAt) })}
        </p>
        {invitation.delivery === "failed" && invitation.error !== null && (
          <p className="mt-0.5 text-xs text-bad">{invitation.error}</p>
        )}
      </div>
      <div className="col-start-2 flex flex-wrap items-center gap-0.5 sm:col-start-auto">
        <Tooltip content={t("invitations.resend")}>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("invitations.resendFor", { email: invitation.email })}
            onClick={onResend}
          >
            <Send aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
        <Tooltip content={t("invitations.revoke")}>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("invitations.revokeFor", { email: invitation.email })}
            onClick={onRevoke}
          >
            <Trash2 aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
      </div>
    </li>
  );
}

/** The people invited who haven't created their account yet. Nothing shows while there are none. */
export function PendingInvitations() {
  const { t } = useTranslation(["settings-access", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(invitationsQuery);
  const [resending, setResending] = useState<Invitation | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);

  const revoke = async () => {
    if (revoking === null) {
      return false;
    }
    await invitationsApi.revoke(revoking.id);
    await queryClient.invalidateQueries({ queryKey: ["invitations"] });
    toast.success(t("invitations.revoked"));
    return true;
  };

  if (!isPending && !isError && data.invitations.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="pending-invitations" className="grid gap-3">
      <div>
        <h3 id="pending-invitations" className="text-base font-medium">
          {t("invitations.pendingTitle")}
        </h3>
        <p className="mt-0.5 text-sm text-muted">{t("invitations.pendingDescription")}</p>
      </div>
      {isPending ? (
        <Skeleton className="h-16" />
      ) : isError ? (
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      ) : (
        <ul className="border-t">
          {data.invitations.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              onResend={() => setResending(invitation)}
              onRevoke={() => setRevoking(invitation)}
            />
          ))}
        </ul>
      )}
      <ResendDialog invitation={resending} onClose={() => setResending(null)} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("invitations.revokeTitle")}
        description={
          revoking === null ? undefined : t("invitations.revokeDescription", { email: revoking.email })
        }
        confirmLabel={t("invitations.revoke")}
        onConfirm={revoke}
      />
    </section>
  );
}
