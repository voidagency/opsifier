import { statfs } from "node:fs/promises";
import { hostname } from "node:os";
import type {
  NotificationChannel,
  NotificationDelivery,
  NotificationEvents,
  NotificationSettings,
  SaveNotificationChannelRequest,
  TestNotificationRequest,
  TestNotificationResult,
} from "@opsifier/contract";
import {
  backupActionTypes,
  defaultNotificationEvents,
  isDeploymentAction,
  nextCronOccurrence,
  notificationEvents,
  parseCron,
  rollbackActionType,
} from "@opsifier/contract";
import { nanoid } from "nanoid";
import type { z } from "zod";
import type { ActionRow } from "../../core/actions";
import type { Principal } from "../../core/auth";
import type { AppDeps } from "../../core/context";
import { badRequest, notFound } from "../../core/errors";
import { assertOwner } from "../access/service";
import { panelUpdates } from "../panel-update/service";
import { getSetting, putSetting } from "../system/repo";
import { DestinationError, resolveDestination } from "./destinations";
import * as repo from "./repo";
import {
  DeliveryError,
  type OutgoingMessage,
  redact,
  type SenderOptions,
  sendDiscord,
  sendSlack,
  sendSmtp,
  sendTelegram,
  sendWebhook,
} from "./senders";

const SETTINGS_KEY = "notification_settings";
const SECRETS_CONTEXT = "notification-channel";
/** Bounded retries: 1s, then 5s, then give up after a third attempt. */
export const RETRY_DELAYS_MS = [1000, 5000];
const DISK_CHECK_INTERVAL_MS = 60_000;

type Config = Record<string, unknown>;

/** The fields of a channel that are secrets, sealed together. */
const SECRET_FIELDS: Record<string, string[]> = {
  discord: ["webhookUrl"],
  slack: ["webhookUrl"],
  telegram: ["botToken"],
  smtp: ["password"],
  webhook: ["url", "secret"],
};

function splitConfig(config: Config): { open: Config; secrets: Record<string, string> } {
  const secretFields = new Set(SECRET_FIELDS[String(config.type)] ?? []);
  const open: Config = {};
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (secretFields.has(key)) {
      if (typeof value === "string" && value !== "") {
        secrets[key] = value;
      }
    } else {
      open[key] = value;
    }
  }
  return { open, secrets };
}

const sealContext = (id: string) => `${SECRETS_CONTEXT}:${id}`;

function sealSecrets(deps: AppDeps, id: string, secrets: Record<string, string>): string | null {
  return Object.keys(secrets).length === 0
    ? null
    : deps.secrets.seal(JSON.stringify(secrets), sealContext(id));
}

function unsealSecrets(deps: AppDeps, row: repo.ChannelRow): Record<string, string> {
  return row.sealedSecrets === null
    ? {}
    : JSON.parse(deps.secrets.unseal(row.sealedSecrets, sealContext(row.id)));
}

/** Enough to recognise a destination, and never anything that would let someone use it. */
function targetOf(config: Config, secrets: Record<string, string>): string {
  switch (config.type) {
    case "discord":
      return "discord.com";
    case "slack":
      return "hooks.slack.com";
    case "telegram":
      return `Chat ${String(config.chatId)}`;
    case "smtp":
      return `${String(config.host)}:${String(config.port)}`;
    case "webhook": {
      try {
        return new URL(secrets.url ?? "").host;
      } catch {
        return "";
      }
    }
    default:
      return "";
  }
}

function toChannel(deps: AppDeps, row: repo.ChannelRow): NotificationChannel {
  const last = repo.lastDeliveryOf(deps.db, row.id);
  const secrets = unsealSecrets(deps, row);
  return {
    id: row.id,
    name: row.name,
    type: row.type as NotificationChannel["type"],
    target: targetOf(row.config, secrets),
    hasSecret: Object.keys(secrets).length > 0,
    config: row.config,
    events: notificationEvents.catch(defaultNotificationEvents).parse(row.events),
    createdAt: row.createdAt.toISOString(),
    lastDeliveryAt: last?.updatedAt.toISOString() ?? null,
    lastDeliveryOk: last === undefined ? null : last.status === "sent",
  };
}

export function readSettings(deps: Pick<AppDeps, "db">): NotificationSettings {
  const stored = getSetting(deps.db, SETTINGS_KEY) as Partial<NotificationSettings> | undefined;
  return { allowPrivateDestinations: stored?.allowPrivateDestinations === true };
}

export function listChannelsView(deps: AppDeps): NotificationChannel[] {
  return repo.listChannels(deps.db).map((row) => toChannel(deps, row));
}

export function saveSettings(
  deps: AppDeps,
  principal: Extract<Principal, { kind: "session" }>,
  settings: NotificationSettings,
): void {
  assertOwner(principal);
  putSetting(deps.db, SETTINGS_KEY, settings, new Date(deps.now()));
  deps.actions.record({
    type: "notification.settings",
    title: `${settings.allowPrivateDestinations ? "Allow" : "Block"} notifications to private addresses`,
    actorEmail: principal.user.email,
  });
}

const senderOptions = (deps: AppDeps): SenderOptions => ({
  allowPrivate: readSettings(deps).allowPrivateDestinations,
  telegramApi: deps.config.telegramApiUrl,
});

function destinationHost(config: Config): string | null {
  if (config.type === "webhook" && typeof config.url === "string") {
    return new URL(config.url).hostname;
  }
  if (config.type === "smtp") {
    return String(config.host);
  }
  return null;
}

/** A private address is refused when it is saved, and again when anything is sent to it. */
async function assertDestinationAllowed(deps: AppDeps, config: Config): Promise<void> {
  const host = destinationHost(config);
  if (host === null) {
    return;
  }
  try {
    await resolveDestination(host, { allowPrivate: readSettings(deps).allowPrivateDestinations });
  } catch (error) {
    if (error instanceof DestinationError) {
      // A name that doesn't resolve yet is a typo or a future record, and is reported at the test send.
      if (error.message.includes("could not be resolved")) {
        return;
      }
      throw badRequest("destination_forbidden", error.message, {
        [config.type === "webhook" ? "url" : "host"]: error.message,
      });
    }
    throw error;
  }
}

function requireSecrets(config: Config): void {
  const needed: Record<string, string> = {
    discord: "webhookUrl",
    slack: "webhookUrl",
    telegram: "botToken",
    webhook: "url",
  };
  const field = needed[String(config.type)];
  if (field !== undefined && (typeof config[field] !== "string" || config[field] === "")) {
    throw badRequest("validation_failed", "Some fields need attention.", { [field]: "Required" });
  }
}

export async function createChannel(
  deps: AppDeps,
  request: z.output<typeof import("@opsifier/contract").saveNotificationChannelRequest>,
  actorEmail: string | undefined,
): Promise<NotificationChannel> {
  requireSecrets(request.config);
  await assertDestinationAllowed(deps, request.config);
  const id = nanoid();
  const { open, secrets } = splitConfig(request.config);
  const now = new Date(deps.now());
  repo.insertChannel(deps.db, {
    id,
    name: request.name,
    type: request.config.type,
    config: open,
    sealedSecrets: sealSecrets(deps, id, secrets),
    events: request.events,
    createdAt: now,
    updatedAt: now,
  });
  deps.actions.record({
    type: "notification.create",
    title: `Add the notification channel ${request.name}`,
    actorEmail,
  });
  return toChannel(deps, repo.findChannel(deps.db, id) as repo.ChannelRow);
}

function requireChannel(deps: AppDeps, id: string): repo.ChannelRow {
  const row = repo.findChannel(deps.db, id);
  if (row === undefined) {
    throw notFound("This channel does not exist.");
  }
  return row;
}

export async function updateChannel(
  deps: AppDeps,
  id: string,
  request: z.output<typeof import("@opsifier/contract").saveNotificationChannelRequest>,
  actorEmail: string | undefined,
): Promise<NotificationChannel> {
  const row = requireChannel(deps, id);
  const stored = unsealSecrets(deps, row);
  const { open, secrets } = splitConfig(request.config);
  // A secret left empty stays as it is, so editing a name never means typing a token again.
  const merged = { ...stored, ...secrets };
  if (row.type !== request.config.type) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      type: "A channel's type can't change",
    });
  }
  requireSecrets({ ...open, ...merged });
  await assertDestinationAllowed(deps, { ...open, ...merged });
  repo.updateChannel(deps.db, id, {
    name: request.name,
    config: open,
    sealedSecrets: sealSecrets(deps, id, merged),
    events: request.events,
    updatedAt: new Date(deps.now()),
  });
  deps.actions.record({
    type: "notification.update",
    title: `Update the notification channel ${request.name}`,
    actorEmail,
  });
  return toChannel(deps, repo.findChannel(deps.db, id) as repo.ChannelRow);
}

export function deleteChannel(deps: AppDeps, id: string, actorEmail: string | undefined): void {
  const row = requireChannel(deps, id);
  repo.deleteChannel(deps.db, id);
  deps.actions.record({
    type: "notification.delete",
    title: `Delete the notification channel ${row.name}`,
    actorEmail,
  });
}

const allSecrets = (secrets: Record<string, string>) => Object.values(secrets);

async function dispatch(
  config: Config,
  secrets: Record<string, string>,
  message: OutgoingMessage,
  options: SenderOptions,
): Promise<string> {
  switch (config.type) {
    case "discord":
      return sendDiscord(secrets.webhookUrl ?? "", message, options);
    case "slack":
      return sendSlack(secrets.webhookUrl ?? "", message, options);
    case "telegram":
      return sendTelegram(secrets.botToken ?? "", String(config.chatId), message, options);
    case "smtp":
      return sendSmtp(
        {
          host: String(config.host),
          port: Number(config.port),
          username: String(config.username ?? ""),
          password: secrets.password,
          from: String(config.from),
          recipients: config.recipients as string[],
        },
        message,
        options,
      );
    case "webhook":
      return sendWebhook(secrets.url ?? "", secrets.secret, message, options);
    default:
      throw new DeliveryError("This channel type can't send anything.");
  }
}

/** A test send from what the form holds right now, with stored secrets filling in any left empty. */
export async function testChannel(
  deps: AppDeps,
  request: z.output<typeof import("@opsifier/contract").testNotificationRequest>,
): Promise<TestNotificationResult> {
  const { open, secrets } = splitConfig(request.config);
  let merged = secrets;
  if (request.id !== undefined) {
    const row = repo.findChannel(deps.db, request.id);
    if (row !== undefined && row.type === request.config.type) {
      merged = { ...unsealSecrets(deps, row), ...secrets };
    }
  }
  requireSecrets({ ...open, ...merged });
  await assertDestinationAllowed(deps, { ...open, ...merged });

  const message: OutgoingMessage = {
    eventId: `test:${nanoid()}`,
    event: "test",
    title: "Opsifier test notification",
    body: `This is a test from ${hostname()}. If you can read it, this channel works.`,
    at: new Date(deps.now()).toISOString(),
  };
  try {
    const detail = await dispatch(open, merged, message, senderOptions(deps));
    return { ok: true, detail: redact(detail, allSecrets(merged)) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The test could not be sent.";
    return { ok: false, detail: redact(reason, allSecrets(merged)) };
  }
}

export function listDeliveries(deps: AppDeps): NotificationDelivery[] {
  return repo.listDeliveries(deps.db).map((row) => ({
    id: row.id,
    eventId: row.eventId,
    channelId: row.channelId,
    channelName: row.channelName,
    event: row.event,
    title: row.title,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export interface PanelEvent {
  /** The same across any repeat of this event, which is what makes a duplicate a duplicate. */
  id: string;
  name: keyof Omit<NotificationEvents, "diskUsage"> | "diskUsage";
  title: string;
  body: string;
}

function wantsEvent(channel: repo.ChannelRow, name: PanelEvent["name"]): boolean {
  const events = notificationEvents.catch(defaultNotificationEvents).parse(channel.events);
  return name === "diskUsage" ? events.diskUsage.enabled : events[name];
}

export interface DeliverOptions {
  /** Waited between attempts. Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  channelId?: string;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });

/** One event to every channel that asked for it. A failure here never touches the job it reports on. */
export function emitEvent(deps: AppDeps, event: PanelEvent, options: DeliverOptions = {}): void {
  for (const channel of repo.listChannels(deps.db)) {
    if (
      (options.channelId === undefined || options.channelId === channel.id) &&
      wantsEvent(channel, event.name)
    ) {
      void deliverToChannel(deps, channel, event, options).catch((error: unknown) => {
        deps.logger.warn({ err: error, eventId: event.id }, "Could not deliver a notification");
      });
    }
  }
}

export async function deliverToChannel(
  deps: AppDeps,
  channel: repo.ChannelRow,
  event: PanelEvent,
  options: DeliverOptions = {},
): Promise<void> {
  const deliveryId = nanoid();
  const timestamp = new Date(deps.now());
  const inserted = repo.insertDelivery(deps.db, {
    id: deliveryId,
    eventId: event.id,
    channelId: channel.id,
    channelName: channel.name,
    event: event.name,
    title: event.title,
    body: event.body,
    status: "pending",
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  if (!inserted) {
    return;
  }

  const secrets = unsealSecrets(deps, channel);
  const message: OutgoingMessage = {
    eventId: event.id,
    event: event.name,
    title: event.title,
    body: event.body,
    at: timestamp.toISOString(),
  };
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt += 1) {
    try {
      await dispatch(channel.config, secrets, message, senderOptions(deps));
      repo.updateDelivery(deps.db, deliveryId, {
        status: "sent",
        attempts: attempt,
        lastError: null,
        updatedAt: new Date(deps.now()),
      });
      return;
    } catch (error) {
      const reason = redact(error instanceof Error ? error.message : "Delivery failed.", allSecrets(secrets));
      const final = attempt > RETRY_DELAYS_MS.length;
      repo.updateDelivery(deps.db, deliveryId, {
        status: final ? "failed" : "pending",
        attempts: attempt,
        lastError: reason.slice(0, 500),
        updatedAt: new Date(deps.now()),
      });
      if (final) {
        return;
      }
      await sleep(RETRY_DELAYS_MS[attempt - 1] as number);
    }
  }
}

const BACKUP_TYPES: ReadonlySet<string> = new Set(Object.values(backupActionTypes));

function describeAction(row: ActionRow): PanelEvent | null {
  const succeeded = row.status === "succeeded";
  if (row.status === "cancelled") {
    return null;
  }
  const ended = succeeded ? "succeeded" : row.status === "uncertain" ? "may not have finished" : "failed";
  const where = row.serviceName === null ? (row.projectName ?? "") : `${row.projectName}/${row.serviceName}`;
  if (isDeploymentAction(row.type)) {
    return {
      id: `action:${row.id}`,
      name: "deploy",
      title: `${row.type === rollbackActionType ? "Rollback" : "Deployment"} of ${where} ${ended}`,
      body: succeeded ? row.title : `${row.title}${row.error === null ? "" : `\n${row.error}`}`,
    };
  }
  if (BACKUP_TYPES.has(row.type)) {
    return {
      id: `action:${row.id}`,
      name: "backup",
      title: `${row.title} ${ended}`,
      body: succeeded ? "" : (row.error ?? ""),
    };
  }
  if (row.type === "docker.cleanup") {
    return {
      id: `action:${row.id}`,
      name: "dockerCleanup",
      title: `${row.title} ${succeeded ? "finished" : ended}`,
      body: succeeded ? "" : (row.error ?? ""),
    };
  }
  return null;
}

async function checkDiskThresholds(deps: AppDeps): Promise<void> {
  const channels = repo.listChannels(deps.db);
  const now = deps.now();
  for (const channel of channels) {
    const events = notificationEvents.catch(defaultNotificationEvents).parse(channel.events);
    if (!events.diskUsage.enabled) {
      continue;
    }
    const last = channel.lastDiskCheckAt?.getTime() ?? channel.createdAt.getTime();
    const next = nextCronOccurrence(parseCron(events.diskUsage.cron), last);
    if (next === null || next > now) {
      continue;
    }
    repo.updateChannel(deps.db, channel.id, { lastDiskCheckAt: new Date(now) });
    const fs = await statfs(deps.config.dataDir).catch(() => null);
    if (fs === null) {
      continue;
    }
    const used = Number(fs.blocks - fs.bfree) * fs.bsize;
    const total = used + Number(fs.bavail) * fs.bsize;
    const percent = total > 0 ? (used / total) * 100 : 0;
    if (percent >= events.diskUsage.minPercent) {
      emitEvent(
        deps,
        {
          id: `disk:${channel.id}:${next}`,
          name: "diskUsage",
          title: `Disk usage at ${percent.toFixed(0)}% on ${hostname()}`,
          body: `${(used / 1024 ** 3).toFixed(1)} GB of ${(total / 1024 ** 3).toFixed(1)} GB used on ${deps.config.dataDir}`,
        },
        { channelId: channel.id },
      );
    }
  }
}

const boots = new WeakMap<AppDeps, { unsubscribe: () => void; timer: NodeJS.Timeout }>();
/** Six hours in minute ticks. The panel's own check is what actually asks the release feed. */
const UPDATE_CHECK_EVERY_TICKS = 360;
let updateChecks = 0;

async function checkForUpdate(deps: AppDeps): Promise<void> {
  const status = await panelUpdates(deps).status();
  if (status.updateAvailable && status.latest !== null) {
    emitEvent(deps, {
      id: `update:${status.latest.version}`,
      name: "updateAvailable",
      title: `Opsifier ${status.latest.version} is available`,
      body: `This server runs ${status.activeVersion}.`,
    });
  }
}

export function startNotifications(deps: AppDeps): void {
  const unsubscribe = deps.actions.onFinished((row) => {
    const event = describeAction(row);
    if (event !== null) {
      emitEvent(deps, event);
    }
  });
  const timer = setInterval(() => {
    void checkDiskThresholds(deps).catch((error: unknown) => {
      deps.logger.warn({ err: error }, "Could not check disk usage");
    });
    try {
      repo.pruneDeliveries(deps.db);
    } catch (error) {
      deps.logger.warn({ err: error }, "Could not prune notification deliveries");
    }
    updateChecks += 1;
    if (updateChecks % UPDATE_CHECK_EVERY_TICKS === 0) {
      void checkForUpdate(deps).catch((error: unknown) => {
        deps.logger.debug({ err: error }, "Could not check for a panel update");
      });
    }
  }, DISK_CHECK_INTERVAL_MS);
  timer.unref();
  boots.set(deps, { unsubscribe, timer });
}

export function stopNotifications(deps: AppDeps): void {
  const running = boots.get(deps);
  if (running !== undefined) {
    running.unsubscribe();
    clearInterval(running.timer);
    boots.delete(deps);
  }
}

export type { SaveNotificationChannelRequest, TestNotificationRequest };
