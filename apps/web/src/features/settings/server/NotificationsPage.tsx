import type {
  NotificationChannel,
  NotificationChannelConfig,
  NotificationChannelType,
  NotificationEvents,
  TestNotificationResult,
} from "@opsifier/contract";
import { defaultNotificationEvents, notificationChannelTypes } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../../lib/format";
import { errorMessage, useForm } from "../../../lib/forms";
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  countStates,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormBanner,
  HealthSummary,
  Input,
  Lamp,
  MonoValue,
  PasswordInput,
  Pictogram,
  Select,
  Skeleton,
  Switch,
  Tooltip,
  toast,
  type VisualState,
} from "../../../ui";
import { channelsQuery, deliveriesQuery, notificationsApi } from "./api";

interface Values {
  name: string;
  type: NotificationChannelType;
  webhookUrl: string;
  url: string;
  secret: string;
  botToken: string;
  chatId: string;
  host: string;
  port: string;
  username: string;
  password: string;
  from: string;
  recipients: string;
  minPercent: string;
  cron: string;
  [key: string]: unknown;
}

const emptyValues: Values = {
  name: "",
  type: "discord",
  webhookUrl: "",
  url: "",
  secret: "",
  botToken: "",
  chatId: "",
  host: "",
  port: "587",
  username: "",
  password: "",
  from: "",
  recipients: "",
  minPercent: "80",
  cron: "0 2 * * *",
};

function valuesOf(channel: NotificationChannel | null): Values {
  if (channel === null) {
    return emptyValues;
  }
  const config = channel.config;
  return {
    ...emptyValues,
    name: channel.name,
    type: channel.type,
    chatId: String(config.chatId ?? ""),
    host: String(config.host ?? ""),
    port: String(config.port ?? "587"),
    username: String(config.username ?? ""),
    from: String(config.from ?? ""),
    recipients: Array.isArray(config.recipients) ? (config.recipients as string[]).join(", ") : "",
    minPercent: String(channel.events.diskUsage.minPercent),
    cron: channel.events.diskUsage.cron,
  };
}

function toConfig(values: Values): NotificationChannelConfig {
  const maybe = (value: string) => (value === "" ? undefined : value);
  switch (values.type) {
    case "discord":
      return { type: "discord", webhookUrl: maybe(values.webhookUrl) };
    case "slack":
      return { type: "slack", webhookUrl: maybe(values.webhookUrl) };
    case "telegram":
      return { type: "telegram", botToken: maybe(values.botToken), chatId: values.chatId };
    case "smtp":
      return {
        type: "smtp",
        host: values.host,
        port: Number(values.port) || 587,
        username: values.username,
        password: maybe(values.password),
        from: values.from,
        recipients: values.recipients
          .split(/[,\s]+/)
          .map((entry) => entry.trim())
          .filter((entry) => entry !== ""),
      };
    case "webhook":
      return { type: "webhook", url: maybe(values.url), secret: maybe(values.secret) };
  }
}

const pictograms: Record<NotificationChannelType, "webhook" | "notification"> = {
  discord: "webhook",
  slack: "webhook",
  telegram: "notification",
  smtp: "notification",
  webhook: "webhook",
};

function ChannelDialog({
  open,
  onOpenChange,
  channel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel: NotificationChannel | null;
}) {
  const { t } = useTranslation(["settings-notifications", "common"]);
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<NotificationEvents>(defaultNotificationEvents);
  const [test, setTest] = useState<TestNotificationResult | null>(null);
  const [testing, setTesting] = useState(false);

  const form = useForm<Values>({
    t,
    initialValues: emptyValues,
    validate: (values) => {
      const errors: Partial<Record<keyof Values & string, string>> = {};
      if (values.name.trim() === "") {
        errors.name = t("errors.required");
      }
      return errors;
    },
    onSubmit: async (values) => {
      const body = {
        name: values.name,
        config: toConfig(values),
        events: {
          ...events,
          diskUsage: { ...events.diskUsage, minPercent: Number(values.minPercent) || 80, cron: values.cron },
        },
      };
      if (channel === null) {
        await notificationsApi.create(body);
      } else {
        await notificationsApi.update(channel.id, body);
      }
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
      toast.success(t(channel === null ? "created" : "updated"));
      onOpenChange(false);
    },
  });
  const { reset } = form;

  useEffect(() => {
    if (open) {
      reset(valuesOf(channel));
      setEvents(channel?.events ?? defaultNotificationEvents);
      setTest(null);
    }
  }, [open, channel, reset]);

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(
        await notificationsApi.test({
          ...(channel === null ? {} : { id: channel.id }),
          config: toConfig(form.values),
        }),
      );
    } catch (error) {
      setTest({ ok: false, detail: errorMessage(error, t) });
    } finally {
      setTesting(false);
    }
  };

  const type = form.values.type;
  const secretPlaceholder = channel?.hasSecret ? t("stored") : undefined;
  // The server only sends a stored password to the host, port and username it was saved for, and a
  // stored signing secret to its URL, which this form never sees: a new URL may need it again.
  const { host, port, username, url } = form.values;
  const keepsPassword =
    channel?.type === "smtp" &&
    host.trim().toLowerCase() === String(channel.config.host ?? "").toLowerCase() &&
    (Number(port) || 587) === Number(channel.config.port) &&
    username === String(channel.config.username ?? "");
  const passwordAgain = channel?.type === "smtp" && channel.hasSecret && !keepsPassword && username !== "";
  const signingSecretAgain = channel?.type === "webhook" && url !== "";

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(channel === null ? "createTitle" : "editTitle")}
      size="lg"
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button pending={testing} onClick={runTest}>
            {t("test")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        {test !== null && (
          <FormBanner tone={test.ok ? "success" : "error"}>{test.ok ? t("testOk") : test.detail}</FormBanner>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("name")} error={form.errors.name} hint={t("nameHint")}>
            <Input {...form.field("name")} maxLength={64} />
          </Field>
          <Field label={t("type")} hint={channel !== null ? t("typeFixed") : undefined}>
            <Select
              value={type}
              disabled={channel !== null}
              onValueChange={(value) => form.set("type", value as NotificationChannelType)}
              options={notificationChannelTypes.map((value) => ({ value, label: t(`types.${value}`) }))}
            />
          </Field>
        </div>

        {(type === "discord" || type === "slack") && (
          <Field label={t("webhookUrl")} error={form.errors.webhookUrl} hint={t("webhookUrlHint")}>
            <PasswordInput {...form.field("webhookUrl")} autoComplete="off" placeholder={secretPlaceholder} />
          </Field>
        )}
        {type === "telegram" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("botToken")} error={form.errors.botToken} hint={t("botTokenHint")}>
              <PasswordInput {...form.field("botToken")} autoComplete="off" placeholder={secretPlaceholder} />
            </Field>
            <Field label={t("chatId")} error={form.errors.chatId} hint={t("chatIdHint")}>
              <Input {...form.field("chatId")} mono />
            </Field>
          </div>
        )}
        {type === "smtp" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("host")} error={form.errors.host} hint={t("hostHint")}>
              <Input {...form.field("host")} mono />
            </Field>
            <Field label={t("port")} error={form.errors.port} hint={t("portHint")}>
              <Input {...form.field("port")} mono inputMode="numeric" />
            </Field>
            <Field label={t("username")} error={form.errors.username} hint={t("usernameHint")}>
              <Input {...form.field("username")} autoComplete="off" />
            </Field>
            <Field
              label={t("password")}
              error={form.errors.password}
              hint={t(passwordAgain ? "passwordAgain" : "passwordHint")}
            >
              <PasswordInput
                {...form.field("password")}
                autoComplete="off"
                placeholder={keepsPassword ? secretPlaceholder : undefined}
              />
            </Field>
            <Field label={t("from")} error={form.errors.from} hint={t("fromHint")}>
              <Input {...form.field("from")} />
            </Field>
            <Field label={t("recipients")} error={form.errors.recipients} hint={t("recipientsHint")}>
              <Input {...form.field("recipients")} />
            </Field>
          </div>
        )}
        {type === "webhook" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("url")} error={form.errors.url} hint={t("urlHint")}>
              <PasswordInput {...form.field("url")} autoComplete="off" placeholder={secretPlaceholder} />
            </Field>
            <Field
              label={t("signingSecret")}
              optional
              error={form.errors.secret}
              hint={t(signingSecretAgain ? "signingSecretAgain" : "signingSecretHint")}
            >
              <PasswordInput
                {...form.field("secret")}
                autoComplete="off"
                placeholder={signingSecretAgain ? undefined : secretPlaceholder}
              />
            </Field>
          </div>
        )}

        <fieldset className="grid gap-2 border-t pt-4">
          <legend className="text-sm font-medium">{t("events.title")}</legend>
          {(["deploy", "backup", "dockerCleanup", "updateAvailable"] as const).map((key) => (
            <Checkbox
              key={key}
              label={t(`events.${key}`)}
              checked={events[key]}
              onChange={(event) => {
                // Read now: React runs the update later, when the event no longer has a target.
                const checked = event.currentTarget.checked;
                setEvents((current) => ({ ...current, [key]: checked }));
              }}
            />
          ))}
          <div className="grid gap-2">
            <Checkbox
              label={t("events.diskUsage")}
              checked={events.diskUsage.enabled}
              onChange={(event) => {
                const enabled = event.currentTarget.checked;
                setEvents((current) => ({ ...current, diskUsage: { ...current.diskUsage, enabled } }));
              }}
            />
            {events.diskUsage.enabled && (
              <div className="grid gap-3 pl-6 sm:grid-cols-2">
                <Field
                  label={t("events.minPercent")}
                  error={form.errors.minPercent}
                  hint={t("events.minPercentHint")}
                >
                  <Input {...form.field("minPercent")} mono inputMode="numeric" className="w-24" />
                </Field>
                <Field label={t("events.cron")} error={form.errors.cron} hint={t("events.cronHint")}>
                  <Input {...form.field("cron")} mono />
                </Field>
              </div>
            )}
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}

function channelState(channel: NotificationChannel): VisualState {
  if (channel.lastDeliveryOk === null) {
    return "unknown";
  }
  return channel.lastDeliveryOk ? "running" : "failed";
}

function DeliveriesPanel() {
  const { t, i18n } = useTranslation("settings-notifications");
  const { data } = useQuery(deliveriesQuery);
  const deliveries = data?.deliveries ?? [];
  if (deliveries.length === 0) {
    return null;
  }
  return (
    <section className="grid gap-2">
      <h3 className="eyebrow">{t("deliveries")}</h3>
      <ul className="border-t">
        {deliveries.slice(0, 20).map((delivery) => (
          <li
            key={delivery.id}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b py-2 last:border-b-0"
          >
            <Lamp
              state={
                delivery.status === "sent" ? "running" : delivery.status === "failed" ? "failed" : "progress"
              }
              size="xs"
              still
              label={delivery.status}
            />
            <div className="min-w-0">
              <p className="truncate text-sm">{delivery.title}</p>
              <p className="truncate text-xs text-muted">
                {delivery.channelName}
                {delivery.lastError === null ? "" : ` · ${delivery.lastError}`}
              </p>
            </div>
            <span className="text-xs text-muted">
              {formatRelativeTime(delivery.createdAt, i18n.language)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Where alerts go, and which ones each destination wants. */
export function NotificationsPage() {
  const { t, i18n } = useTranslation(["settings-notifications", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(channelsQuery);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<NotificationChannel | null>(null);
  const [deleting, setDeleting] = useState<NotificationChannel | null>(null);
  const [filter, setFilter] = useState<VisualState | null>(null);

  const channels = data?.channels ?? [];
  const counts = useMemo(() => countStates(channels.map(channelState)), [channels]);
  const shown = filter === null ? channels : channels.filter((channel) => channelState(channel) === filter);

  const remove = async () => {
    if (deleting === null) {
      return false;
    }
    await notificationsApi.remove(deleting.id);
    await queryClient.invalidateQueries({ queryKey: ["notifications"] });
    toast.success(t("deleted"));
    return true;
  };

  const setAllowPrivate = async (allowed: boolean) => {
    try {
      await notificationsApi.setAllowPrivate(allowed);
      await queryClient.invalidateQueries({ queryKey: ["notifications"] });
    } catch (failure) {
      toast.error(errorMessage(failure, t));
    }
  };

  const addButton = (
    <Button
      variant="primary"
      icon={<Plus aria-hidden="true" className="size-4" />}
      onClick={() => setCreating(true)}
    >
      {t("add")}
    </Button>
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 px-4 py-6 md:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-md font-medium">{t("title")}</h2>
          <p className="mt-1 max-w-[60ch] text-sm text-muted">{t("description")}</p>
        </div>
        {addButton}
      </div>
      {isPending ? (
        <Skeleton className="h-24" />
      ) : isError ? (
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      ) : channels.length === 0 ? (
        <EmptyState
          illustration="no-activity"
          title={t("emptyTitle")}
          description={t("emptyDescription")}
          action={addButton}
        />
      ) : (
        <>
          <HealthSummary counts={counts} selected={filter} onSelect={setFilter} />
          <ul className="border-t">
            {shown.map((channel) => (
              <li
                key={channel.id}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b py-2.5 last:border-b-0"
              >
                <span className="inline-flex items-center gap-1.5 text-muted">
                  <Pictogram name={pictograms[channel.type]} size={16} />
                  <Lamp
                    state={channelState(channel)}
                    label={t(
                      channelState(channel) === "unknown"
                        ? "neverUsed"
                        : channel.lastDeliveryOk
                          ? "lastOk"
                          : "lastFailed",
                    )}
                  />
                </span>
                <div className="min-w-0">
                  <p className="flex items-center gap-2">
                    <span className="truncate font-medium">{channel.name}</span>
                    <Badge>{t(`types.${channel.type}`)}</Badge>
                  </p>
                  <p className="truncate text-xs text-muted">
                    <MonoValue value={channel.target} />
                    {channel.lastDeliveryAt === null
                      ? ""
                      : ` · ${formatRelativeTime(channel.lastDeliveryAt, i18n.language)}`}
                  </p>
                </div>
                <div className="flex gap-0.5">
                  <Tooltip content={t("edit")}>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("edit")}
                      onClick={() => setEditing(channel)}
                    >
                      <Pencil aria-hidden="true" className="size-4" />
                    </Button>
                  </Tooltip>
                  <Tooltip content={t("delete")}>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("delete")}
                      onClick={() => setDeleting(channel)}
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </Button>
                  </Tooltip>
                </div>
              </li>
            ))}
          </ul>
          <DeliveriesPanel />
        </>
      )}
      {data !== undefined && (
        <section className="grid max-w-[850px] gap-1 border-t pt-4">
          <Switch
            label={t("allowPrivate")}
            hint={data.canChangeSettings ? t("allowPrivateHint") : t("ownerOnly")}
            checked={data.settings.allowPrivateDestinations}
            disabled={!data.canChangeSettings}
            onCheckedChange={setAllowPrivate}
          />
        </section>
      )}
      <ChannelDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        channel={editing}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("deleteTitle")}
        description={deleting === null ? undefined : t("deleteDescription", { name: deleting.name })}
        confirmLabel={t("delete")}
        onConfirm={remove}
      />
    </div>
  );
}
