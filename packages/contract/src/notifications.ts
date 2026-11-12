import { z } from "zod";
import { cronProblem } from "./cron";

export const notificationChannelTypes = ["discord", "slack", "telegram", "smtp", "webhook"] as const;
export const notificationChannelType = z.enum(notificationChannelTypes);
export type NotificationChannelType = z.infer<typeof notificationChannelType>;

export const notificationEvents = z.strictObject({
  deploy: z.boolean(),
  backup: z.boolean(),
  dockerCleanup: z.boolean(),
  updateAvailable: z.boolean(),
  diskUsage: z.strictObject({
    enabled: z.boolean(),
    minPercent: z.number().int().min(1, "At least 1").max(100, "At most 100"),
    cron: z
      .string()
      .trim()
      .max(120, "This is too long")
      .superRefine((value, context) => {
        const problem = cronProblem(value);
        if (problem !== null) {
          context.addIssue({ code: "custom", message: problem });
        }
      }),
  }),
});
export type NotificationEvents = z.infer<typeof notificationEvents>;

export const defaultNotificationEvents: NotificationEvents = {
  deploy: true,
  backup: true,
  dockerCleanup: true,
  updateAvailable: true,
  diskUsage: { enabled: true, minPercent: 80, cron: "0 2 * * *" },
};

const name = z.string().trim().min(1, "Required").max(64, "Must be at most 64 characters");

const httpUrl = z
  .url("Enter a full URL")
  .max(2048, "This is too long")
  .refine((value) => /^https?:\/\//i.test(value), "Must start with http:// or https://");

const httpsUrlOn = (hosts: readonly string[], message: string) =>
  httpUrl.refine((value) => {
    const host = /^https:\/\/([^/:?#]+)(?::\d+)?(?:[/?#]|$)/i.exec(value)?.[1]?.toLowerCase();
    return host !== undefined && hosts.includes(host);
  }, message);

/**
 * A secret left empty on an update keeps the value already stored, while the destination it was saved
 * for stays the same: an SMTP host, port and username, a webhook URL.
 */
const secret = (max: number) => z.string().max(max, "This is too long").optional();

export const notificationChannelConfig = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("discord"),
    webhookUrl: httpsUrlOn(
      ["discord.com", "discordapp.com"],
      "Use the webhook URL Discord gave you",
    ).optional(),
  }),
  z.strictObject({
    type: z.literal("slack"),
    webhookUrl: httpsUrlOn(["hooks.slack.com"], "Use the webhook URL Slack gave you").optional(),
  }),
  z.strictObject({
    type: z.literal("telegram"),
    botToken: secret(256),
    chatId: z.string().trim().min(1, "Required").max(64, "This is too long"),
  }),
  z.strictObject({
    type: z.literal("smtp"),
    host: z
      .string()
      .trim()
      .min(1, "Required")
      .max(253, "This is too long")
      .regex(/^[A-Za-z0-9.:-]+$/, "Enter a hostname or an address"),
    port: z.number().int().min(1).max(65535).default(587),
    username: z.string().max(254, "This is too long").default(""),
    password: secret(1024),
    from: z.email("Enter a valid email address").max(254),
    recipients: z
      .array(z.email("Enter a valid email address").max(254))
      .min(1, "Add at least one recipient")
      .max(50, "At most 50 recipients"),
  }),
  z.strictObject({
    type: z.literal("webhook"),
    url: httpUrl.optional(),
    /** Signs the body with HMAC-SHA256, sent in `X-Opsifier-Signature`. */
    secret: secret(256),
  }),
]);
export type NotificationChannelConfig = z.input<typeof notificationChannelConfig>;

/** POST and PUT on /api/v1/notifications/channels */
export const saveNotificationChannelRequest = z.strictObject({
  name,
  config: notificationChannelConfig,
  events: notificationEvents,
});
export type SaveNotificationChannelRequest = z.input<typeof saveNotificationChannelRequest>;

/**
 * POST /api/v1/notifications/test: unsaved form values, with an `id` to reuse stored secrets for the
 * destination they were saved for.
 */
export const testNotificationRequest = z.strictObject({
  id: z.string().max(64).optional(),
  config: notificationChannelConfig,
});
export type TestNotificationRequest = z.input<typeof testNotificationRequest>;

export const testNotificationResult = z.object({
  ok: z.boolean(),
  /** What the destination said, with any secret removed. */
  detail: z.string(),
});
export type TestNotificationResult = z.infer<typeof testNotificationResult>;

/** A channel as the API shows it: secrets are only ever reported as being present. */
export const notificationChannel = z.object({
  id: z.string(),
  name: z.string(),
  type: notificationChannelType,
  /** A short description of where messages go, such as a host or a chat id. Never a secret. */
  target: z.string(),
  hasSecret: z.boolean(),
  /** The non-secret fields, for filling in the edit form. A secret is never among them. */
  config: z.record(z.string(), z.unknown()),
  events: notificationEvents,
  createdAt: z.iso.datetime(),
  lastDeliveryAt: z.iso.datetime().nullable(),
  lastDeliveryOk: z.boolean().nullable(),
});
export type NotificationChannel = z.infer<typeof notificationChannel>;

export const notificationChannelPath = z.object({
  channel: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id"),
});

/** GET /api/v1/notifications/settings. Only the owner may change this. */
export const notificationSettings = z.strictObject({
  /** Lets channels reach loopback, link-local and other private addresses. */
  allowPrivateDestinations: z.boolean(),
});
export type NotificationSettings = z.infer<typeof notificationSettings>;

export const notificationChannelList = z.object({
  channels: z.array(notificationChannel),
  settings: notificationSettings,
  /** Whether the person asking may change `settings`. */
  canChangeSettings: z.boolean(),
});
export type NotificationChannelList = z.infer<typeof notificationChannelList>;

export const notificationDelivery = z.object({
  id: z.string(),
  /** Stays the same across retries of one event. */
  eventId: z.string(),
  channelId: z.string().nullable(),
  channelName: z.string(),
  event: z.string(),
  title: z.string(),
  status: z.enum(["pending", "sent", "failed"]),
  attempts: z.number().int().min(0),
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type NotificationDelivery = z.infer<typeof notificationDelivery>;

/** GET /api/v1/notifications/deliveries */
export const notificationDeliveryList = z.object({ deliveries: z.array(notificationDelivery) });
export type NotificationDeliveryList = z.infer<typeof notificationDeliveryList>;
