import type { NotificationChannel } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Field, Select } from "../../../../ui";
import { channelsQuery } from "../api";

/** The choice that hands the links over instead of e-mailing them. No channel id can look like it. */
const BY_LINK = "__link";

/** The SMTP notification channels an invitation can go through, oldest first, read once a dialog opens. */
export function useMailChannels(enabled: boolean): NotificationChannel[] {
  const { data } = useQuery({ ...channelsQuery, enabled });
  return (data?.channels ?? []).filter((channel) => channel.type === "smtp");
}

/**
 * The channel an invitation goes through: the one picked, or else the first SMTP channel there is, so
 * that a panel with e-mail set up uses it without being asked. Null hands the links over.
 */
export function chosenChannel(
  picked: string | null | undefined,
  channels: readonly NotificationChannel[],
): string | null {
  return picked === undefined ? (channels[0]?.id ?? null) : picked;
}

export function DeliveryField({
  value,
  onChange,
  channels,
}: {
  value: string | null;
  onChange: (channel: string | null) => void;
  channels: readonly NotificationChannel[];
}) {
  const { t } = useTranslation("settings-access");
  return (
    <Field
      label={t("invitations.delivery")}
      hint={
        channels.length === 0 ? (
          <>
            {t("invitations.noChannel")}{" "}
            <Link to="/settings/server/notifications" className="underline underline-offset-2">
              {t("invitations.addChannel")}
            </Link>
          </>
        ) : value === null ? (
          t("invitations.byLinkHint")
        ) : (
          t("invitations.byEmailHint")
        )
      }
    >
      <Select
        value={value ?? BY_LINK}
        onValueChange={(next) => onChange(next === BY_LINK ? null : next)}
        options={[
          ...channels.map((channel) => ({
            value: channel.id,
            label: t("invitations.byEmail", { name: channel.name, from: String(channel.config.from ?? "") }),
          })),
          { value: BY_LINK, label: t("invitations.byLink") },
        ]}
      />
    </Field>
  );
}
