import {
  type CreatedInvitations,
  INVITATION_DAYS,
  type InvitationOutcome,
  MAX_INVITATIONS_PER_REQUEST,
  type ProjectGrant,
  type ProjectRole,
  type UserRole,
} from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "../../../../lib/forms";
import {
  Badge,
  type BadgeTone,
  Button,
  CopyButton,
  Dialog,
  Field,
  FormBanner,
  Input,
  MonoValue,
  Segmented,
  Textarea,
  useCopy,
} from "../../../../ui";
import { GrantsEditor } from "../GrantsEditor";
import { parseAddresses } from "./addresses";
import { invitationsApi, mailLanguage } from "./api";
import { chosenChannel, DeliveryField, useMailChannels } from "./delivery";

const outcomeTones: Record<InvitationOutcome, BadgeTone> = {
  invited: "ok",
  duplicate: "neutral",
  account_exists: "off",
  already_invited: "off",
};

/** A link shown once, ready to copy. */
export function LinkField({ label, link }: { label: string; link: string }) {
  return (
    <div className="flex items-center gap-2">
      <Input
        mono
        readOnly
        aria-label={label}
        value={link}
        onFocus={(event) => event.currentTarget.select()}
        className="h-8 text-sm"
      />
      <CopyButton value={link} label={label} />
    </div>
  );
}

function CopyAllButton({ text }: { text: string }) {
  const { t } = useTranslation("settings-access");
  const { copied, copy } = useCopy(text);
  return <Button onClick={copy}>{copied ? t("invitations.copiedAll") : t("invitations.copyAll")}</Button>;
}

/** One key per row, though an address can come back more than once: a repeat is reported too. */
function keyed<T extends { email: string }>(entries: readonly T[]): Array<{ entry: T; key: string }> {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const occurrence = (seen.get(entry.email) ?? 0) + 1;
    seen.set(entry.email, occurrence);
    return { entry, key: `${entry.email}#${occurrence}` };
  });
}

function Results({ result }: { result: CreatedInvitations }) {
  const { t } = useTranslation("settings-access");
  const handedOver = result.results.some((entry) => entry.link !== null);
  return (
    <div className="grid gap-4">
      {handedOver && <FormBanner tone="warning">{t("invitations.linksWarning")}</FormBanner>}
      {result.action !== null && <FormBanner tone="success">{t("invitations.emailsQueued")}</FormBanner>}
      <ul className="border-t">
        {keyed(result.results).map(({ entry, key }) => (
          <li key={key} className="grid gap-1.5 border-b py-2.5">
            <p className="flex flex-wrap items-center gap-2">
              <MonoValue value={entry.email} className="text-sm" />
              <Badge tone={outcomeTones[entry.outcome]}>{t(`invitations.outcomes.${entry.outcome}`)}</Badge>
            </p>
            {entry.link !== null && (
              <LinkField label={t("invitations.linkFor", { email: entry.email })} link={entry.link} />
            )}
            {entry.invitation?.delivery === "failed" && (
              <p className="text-sm text-bad">{entry.invitation.error}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Invites a pasted list of people at once, all with the same rights. */
export function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation(["settings-access", "common"]);
  const queryClient = useQueryClient();
  const channels = useMailChannels(open);
  const [role, setRole] = useState<UserRole>("member");
  const [grants, setGrants] = useState<ProjectGrant[]>([]);
  const [allProjects, setAllProjects] = useState<ProjectRole | null>(null);
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const [result, setResult] = useState<CreatedInvitations | null>(null);
  const channel = chosenChannel(picked, channels);

  const form = useForm({
    t,
    initialValues: { emails: "" },
    validate: ({ emails }) => {
      const pasted = parseAddresses(emails);
      if (pasted.invalid.length > 0) {
        return { emails: t("invitations.errors.invalid", { list: pasted.invalid.join(", ") }) };
      }
      if (pasted.emails.length === 0) {
        return { emails: t("invitations.errors.none") };
      }
      if (pasted.emails.length > MAX_INVITATIONS_PER_REQUEST) {
        return { emails: t("invitations.errors.tooMany", { max: MAX_INVITATIONS_PER_REQUEST }) };
      }
      return {};
    },
    onSubmit: async ({ emails }) => {
      const created = await invitationsApi.invite({
        emails: parseAddresses(emails).emails,
        role,
        projects: role === "admin" ? [] : grants,
        allProjects: role === "admin" ? null : allProjects,
        channel,
        language: mailLanguage(i18n.language),
      });
      await queryClient.invalidateQueries({ queryKey: ["invitations"] });
      setResult(created);
    },
  });
  const { reset } = form;

  useEffect(() => {
    if (open) {
      reset({ emails: "" });
      setRole("member");
      setGrants([]);
      setAllProjects(null);
      setPicked(undefined);
      setResult(null);
    }
  }, [open, reset]);

  const pasted = useMemo(() => parseAddresses(form.values.emails), [form.values.emails]);
  const people = pasted.emails.length - pasted.repeated;
  const links = result?.results.filter((entry) => entry.link !== null) ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("invitations.title")}
      description={result === null ? t("invitations.description", { days: INVITATION_DAYS }) : undefined}
      size="lg"
      onSubmit={result === null ? form.handleSubmit : undefined}
      footer={
        result === null ? (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" variant="primary" pending={form.pending}>
              {people === 0 ? t("invitations.submitEmpty") : t("invitations.submit", { count: people })}
            </Button>
          </>
        ) : (
          <>
            {links.length > 1 && (
              <CopyAllButton text={links.map((entry) => `${entry.email} ${entry.link}`).join("\n")} />
            )}
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              {t("invitations.done")}
            </Button>
          </>
        )
      }
    >
      {result !== null ? (
        <Results result={result} />
      ) : (
        <div className="grid gap-4">
          {form.banner && <FormBanner>{form.banner}</FormBanner>}
          <div className="grid gap-1.5">
            <Field
              label={t("invitations.emails")}
              hint={t("invitations.emailsHint", { max: MAX_INVITATIONS_PER_REQUEST })}
              error={form.errors.emails}
            >
              <Textarea
                {...form.field("emails")}
                rows={5}
                mono
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder={"ann@example.com\nbob@example.com"}
              />
            </Field>
            {form.values.emails.trim() !== "" && (
              <p className="text-sm text-muted" aria-live="polite">
                {t("invitations.count", { count: people })}
                {pasted.repeated > 0 && ` · ${t("invitations.repeated", { count: pasted.repeated })}`}
                {pasted.invalid.length > 0 && (
                  <span className="text-bad">
                    {" · "}
                    {t("invitations.notAddresses", { count: pasted.invalid.length })}
                  </span>
                )}
              </p>
            )}
          </div>
          <Field label={t("users.role")} hint={t("invitations.roleHint")}>
            <Segmented
              label={t("users.role")}
              value={role}
              onChange={setRole}
              options={[
                { value: "member", label: t("users.roles.member") },
                { value: "admin", label: t("users.roles.admin") },
              ]}
            />
          </Field>
          {role === "member" && (
            <GrantsEditor
              grants={grants}
              onChange={setGrants}
              allProjects={allProjects}
              onAllProjectsChange={setAllProjects}
            />
          )}
          <DeliveryField value={channel} onChange={setPicked} channels={channels} />
        </div>
      )}
    </Dialog>
  );
}
