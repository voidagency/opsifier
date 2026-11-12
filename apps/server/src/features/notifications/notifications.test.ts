import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo, createServer as createNetServer, type Server as NetServer } from "node:net";
import type {
  NotificationChannel,
  NotificationChannelList,
  NotificationDeliveryList,
  TestNotificationResult,
} from "@opsifier/contract";
import { defaultNotificationEvents } from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { notificationChannels } from "../../core/db/schema";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { isPrivateAddress } from "./destinations";
import * as repo from "./repo";
import { deliverToChannel, emitEvent } from "./service";

let context: TestContext;
let cookie: string;
let stub: Server | undefined;
let received: Array<{ headers: IncomingMessage["headers"]; body: string; url: string | undefined }> = [];
let respond: (res: ServerResponse, attempt: number) => void = (res) => res.writeHead(200).end("ok");

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  received = [];
  respond = (res) => res.writeHead(200).end("ok");
});

afterEach(async () => {
  await context.close();
  stub?.close();
  stub = undefined;
});

async function startStub(): Promise<string> {
  let attempt = 0;
  stub = createServer((req, res) => {
    attempt += 1;
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      received.push({ headers: req.headers, body, url: req.url });
      respond(res, attempt);
    });
  });
  await new Promise<void>((resolve) => stub?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(stub.address() as AddressInfo).port}/hook`;
}

const post = <T = unknown>(path: string, body: unknown) =>
  call<T>(context.app, path, { method: "POST", cookie, origin: TEST_ORIGIN, body });
const put = <T = unknown>(path: string, body: unknown) =>
  call<T>(context.app, path, { method: "PUT", cookie, origin: TEST_ORIGIN, body });

const allowPrivate = () => put("/api/v1/notifications/settings", { allowPrivateDestinations: true });

const channel = (url: string, secret?: string) => ({
  name: "ops",
  config: { type: "webhook", url, ...(secret === undefined ? {} : { secret }) },
  events: defaultNotificationEvents,
});

describe("private destinations", () => {
  it("knows a private address when it sees one", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "::ffff:10.0.0.1",
      // NAT64 addresses of private IPv4 ones, as a resolver with DNS64 would hand them out.
      "64:ff9b::a00:1",
      "64:ff9b::7f00:1",
      "64:ff9b::192.168.1.1",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b::",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of [
      "1.1.1.1",
      "2606:4700:4700::1111",
      "64:ff9b::3412:a5dc",
      "64:ff9b::34.240.193.206",
      "64:ff9b:0:0:0:0:3412:a5dc",
    ]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("refuses to send to a private address until the owner allows it", async () => {
    const url = await startStub();
    const refused = await post("/api/v1/notifications/channels", channel(url));
    expect(refused.status).toBe(400);
    expect(apiErrorOf(refused).code).toBe("destination_forbidden");

    const test = await post<TestNotificationResult>("/api/v1/notifications/test", {
      config: { type: "webhook", url },
    });
    expect(test.status).toBe(400);
    expect(received).toHaveLength(0);

    await allowPrivate();
    expect((await post("/api/v1/notifications/channels", channel(url))).status).toBe(201);
  });

  it("re-checks at send time, and refuses a redirect instead of following it", async () => {
    const url = await startStub();
    await allowPrivate();
    const created = await post<NotificationChannel>("/api/v1/notifications/channels", channel(url));
    await put("/api/v1/notifications/settings", { allowPrivateDestinations: false });

    const row = repo.findChannel(context.deps.db, created.body.id) as repo.ChannelRow;
    await deliverToChannel(
      context.deps,
      row,
      { id: "evt-1", name: "deploy", title: "t", body: "" },
      { sleep: async () => {} },
    );
    expect(received).toHaveLength(0);
    const delivery = repo.listDeliveries(context.deps.db)[0];
    expect(delivery?.status).toBe("failed");
    expect(delivery?.lastError).toContain("private");
  });
});

describe("channels", () => {
  it("seals secrets and never returns them", async () => {
    await allowPrivate();
    const url = `${await startStub()}?token=abc123`;
    const created = await post<NotificationChannel>(
      "/api/v1/notifications/channels",
      channel(url, "shh-secret"),
    );
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain("shh-secret");
    expect(JSON.stringify(created.body)).not.toContain("abc123");

    const row = context.deps.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, created.body.id))
      .get();
    expect(row?.sealedSecrets).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain("shh-secret");

    const list = await call<NotificationChannelList>(context.app, "/api/v1/notifications/channels", {
      cookie,
    });
    expect(JSON.stringify(list.body)).not.toContain("shh-secret");
    expect(list.body.channels[0]).toMatchObject({
      hasSecret: true,
      target: expect.stringContaining("127.0.0.1"),
    });
  });

  it("keeps a stored secret when an edit leaves it empty", async () => {
    await allowPrivate();
    const url = await startStub();
    const created = await post<NotificationChannel>(
      "/api/v1/notifications/channels",
      channel(url, "signing-key"),
    );
    const updated = await put<NotificationChannel>(`/api/v1/notifications/channels/${created.body.id}`, {
      name: "renamed",
      config: { type: "webhook" },
      events: defaultNotificationEvents,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe("renamed");

    const test = await post<TestNotificationResult>("/api/v1/notifications/test", {
      id: created.body.id,
      config: { type: "webhook" },
    });
    expect(test.body.ok).toBe(true);
    const signature = received[0]?.headers["x-opsifier-signature"];
    expect(signature).toBe(
      `sha256=${createHmac("sha256", "signing-key")
        .update(received[0]?.body ?? "")
        .digest("hex")}`,
    );
  });

  it("keeps a signing secret with the URL it was saved for", async () => {
    await allowPrivate();
    const url = await startStub();
    const created = await post<NotificationChannel>(
      "/api/v1/notifications/channels",
      channel(url, "signing-key"),
    );
    const elsewhere = `${url}/elsewhere`;

    const test = await post("/api/v1/notifications/test", {
      id: created.body.id,
      config: { type: "webhook", url: elsewhere },
    });
    expect(test.status).toBe(400);
    expect(apiErrorOf(test)).toMatchObject({
      code: "secret_destination_changed",
      fields: { secret: "Enter the signing secret for this URL again" },
    });
    const moved = await put(`/api/v1/notifications/channels/${created.body.id}`, channel(elsewhere));
    expect(moved.status).toBe(400);
    expect(apiErrorOf(moved).code).toBe("secret_destination_changed");
    expect(received).toHaveLength(0);

    // The same URL typed again, however it is written, is still where the secret belongs.
    const same = await post<TestNotificationResult>("/api/v1/notifications/test", {
      id: created.body.id,
      config: { type: "webhook", url: url.replace("http://", "HTTP://") },
    });
    expect(same.body.ok).toBe(true);
    expect(received[0]?.headers["x-opsifier-signature"]).toBe(
      `sha256=${createHmac("sha256", "signing-key")
        .update(received[0]?.body ?? "")
        .digest("hex")}`,
    );

    const resigned = await put(
      `/api/v1/notifications/channels/${created.body.id}`,
      channel(elsewhere, "another-key"),
    );
    expect(resigned.status).toBe(200);
  });

  it("reuses a Telegram token for another chat, since the token only ever goes to Telegram", async () => {
    const api = new URL(await startStub()).origin;
    await context.close();
    context = await createTestContext({ env: { OPSIFIER_TELEGRAM_API_URL: api } });
    cookie = await setupAdmin(context.app);
    await allowPrivate();
    const created = await post<NotificationChannel>("/api/v1/notifications/channels", {
      name: "tg",
      config: { type: "telegram", botToken: "123:bot-token", chatId: "42" },
      events: defaultNotificationEvents,
    });

    const test = await post<TestNotificationResult>("/api/v1/notifications/test", {
      id: created.body.id,
      config: { type: "telegram", chatId: "99" },
    });

    expect(test.body).toEqual({ ok: true, detail: "HTTP 200" });
    expect(received[0]?.url).toBe("/bot123:bot-token/sendMessage");
    expect(JSON.parse(received[0]?.body ?? "{}")).toMatchObject({ chat_id: "99" });
  });

  it("sends a test from unsaved values and reports a failure with no secret in it", async () => {
    await allowPrivate();
    const url = await startStub();
    const ok = await post<TestNotificationResult>("/api/v1/notifications/test", {
      config: { type: "webhook", url },
    });
    expect(ok.body).toEqual({ ok: true, detail: "HTTP 200" });
    expect(JSON.parse(received[0]?.body ?? "{}")).toMatchObject({
      event: "test",
      title: "Opsifier test notification",
    });

    respond = (res) => res.writeHead(500).end(`boom ${url}`);
    const failed = await post<TestNotificationResult>("/api/v1/notifications/test", {
      config: { type: "webhook", url },
    });
    expect(failed.body.ok).toBe(false);
    expect(failed.body.detail).toContain("500");
    expect(failed.body.detail).not.toContain(url);
  });

  it("validates each type of channel", async () => {
    const discord = await post("/api/v1/notifications/channels", {
      name: "d",
      config: { type: "discord", webhookUrl: "https://evil.example.com/x" },
      events: defaultNotificationEvents,
    });
    expect(discord.status).toBe(400);
    const empty = await post("/api/v1/notifications/channels", {
      name: "t",
      config: { type: "telegram", chatId: "1" },
      events: defaultNotificationEvents,
    });
    expect(empty.status).toBe(400);
    expect(apiErrorOf(empty).fields?.botToken).toBe("Required");
    const badCron = await post("/api/v1/notifications/channels", {
      name: "s",
      config: { type: "smtp", host: "mail.example.com", port: 587, from: "a@b.co", recipients: ["c@d.co"] },
      events: { ...defaultNotificationEvents, diskUsage: { enabled: true, minPercent: 80, cron: "nope" } },
    });
    expect(badCron.status).toBe(400);
  });

  it("lets only the owner allow private destinations", async () => {
    await call(context.app, "/api/v1/users", {
      method: "POST",
      cookie,
      origin: TEST_ORIGIN,
      body: { email: "admin2@example.com", password: "another long passphrase", role: "admin", projects: [] },
    });
    const login = await call<{ status: string }>(context.app, "/api/v1/auth/login", {
      method: "POST",
      origin: TEST_ORIGIN,
      body: { email: "admin2@example.com", password: "another long passphrase" },
    });
    const refused = await call(context.app, "/api/v1/notifications/settings", {
      method: "PUT",
      cookie: login.cookie,
      origin: TEST_ORIGIN,
      body: { allowPrivateDestinations: true },
    });
    expect(refused.status).toBe(403);
    expect(apiErrorOf(refused).code).toBe("owner_required");
  });
});

describe("email", () => {
  let servers: NetServer[] = [];
  let lines: string[] = [];

  afterEach(() => {
    for (const server of servers) {
      server.close();
    }
    servers = [];
    lines = [];
  });

  /** Speaks just enough SMTP and writes down what it hears. Like many relays, it offers no encryption. */
  async function startSmtpStub(heard: string[] = lines): Promise<number> {
    const smtp = createNetServer((socket) => {
      socket.write("220 stub ESMTP\r\n");
      let buffer = "";
      let inData = false;
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (let end = buffer.indexOf("\r\n"); end !== -1; end = buffer.indexOf("\r\n")) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          heard.push(line);
          if (inData) {
            if (line === ".") {
              inData = false;
              socket.write("250 Queued as 42\r\n");
            }
          } else if (line.startsWith("EHLO")) {
            socket.write("250-stub\r\n250 8BITMIME\r\n");
          } else if (line === "STARTTLS") {
            socket.write("502 Not implemented\r\n");
          } else if (line === "DATA") {
            inData = true;
            socket.write("354 Go ahead\r\n");
          } else if (line === "QUIT") {
            socket.end("221 Bye\r\n");
          } else {
            socket.write("250 OK\r\n");
          }
        }
      });
    });
    servers.push(smtp);
    await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
    return (smtp.address() as AddressInfo).port;
  }

  const smtpConfig = (port: number, username = "") => ({
    type: "smtp",
    host: "127.0.0.1",
    port,
    username,
    ...(username === "" ? {} : { password: "a-mail-password" }),
    from: "panel@example.test",
    recipients: ["owner@example.test"],
  });

  it("delivers a test message over SMTP", async () => {
    await allowPrivate();

    const result = await post<TestNotificationResult>("/api/v1/notifications/test", {
      config: smtpConfig(await startSmtpStub()),
    });

    expect(result.body).toMatchObject({ ok: true });
    expect(lines).toContain("MAIL FROM:<panel@example.test>");
    expect(lines).toContain("RCPT TO:<owner@example.test>");
    expect(lines.some((line) => line.startsWith("Subject: =?UTF-8?B?"))).toBe(true);
  });

  it("keeps the password to itself when the server has no encryption", async () => {
    await allowPrivate();

    const result = await post<TestNotificationResult>("/api/v1/notifications/test", {
      config: smtpConfig(await startSmtpStub(), "panel"),
    });

    expect(result.body.ok).toBe(false);
    expect(result.body.detail).toContain("no encryption");
    expect(lines.some((line) => line.startsWith("AUTH"))).toBe(false);
  });

  it("does not reach a private mail server unless the owner allows it", async () => {
    const result = await post<TestNotificationResult>("/api/v1/notifications/test", {
      config: smtpConfig(await startSmtpStub()),
    });

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(lines).toEqual([]);
  });

  describe("a stored password", () => {
    const createMailChannel = async (port: number, host = "127.0.0.1") => {
      const created = await post<NotificationChannel>("/api/v1/notifications/channels", {
        name: "mail",
        config: { ...smtpConfig(port, "panel"), host },
        events: defaultNotificationEvents,
      });
      expect(created.status).toBe(201);
      return created.body.id;
    };

    /** The form as the edit dialog sends it, with the password left empty. */
    const leftEmpty = (port: number) => ({ ...smtpConfig(port, "panel"), password: undefined });

    const storedPassword = (id: string): string | undefined => {
      const row = repo.findChannel(context.deps.db, id) as repo.ChannelRow;
      return row.sealedSecrets === null
        ? undefined
        : JSON.parse(context.deps.secrets.unseal(row.sealedSecrets, `notification-channel:${id}`)).password;
    };

    const edit = (id: string, config: Record<string, unknown>) =>
      put<NotificationChannel>(`/api/v1/notifications/channels/${id}`, {
        name: "mail",
        config,
        events: defaultNotificationEvents,
      });

    it("is never sent by a test to another host, port or username", async () => {
      await allowPrivate();
      const port = await startSmtpStub();
      const id = await createMailChannel(port);
      const elsewhere: string[] = [];
      const otherPort = await startSmtpStub(elsewhere);

      for (const moved of [{ port: otherPort }, { host: "localhost" }, { username: "someone-else" }]) {
        const result = await post("/api/v1/notifications/test", {
          id,
          config: { ...leftEmpty(port), ...moved },
        });
        expect(result.status, JSON.stringify(moved)).toBe(400);
        expect(apiErrorOf(result)).toMatchObject({
          code: "secret_destination_changed",
          fields: { password: "Enter the password for this server again" },
        });
      }
      expect(elsewhere).toEqual([]);
      expect(lines).toEqual([]);
    });

    it("still fills in a test to the same server, whatever the case of its name", async () => {
      await allowPrivate();
      const port = await startSmtpStub();
      const id = await createMailChannel(port, "localhost");

      const result = await post<TestNotificationResult>("/api/v1/notifications/test", {
        id,
        config: { ...leftEmpty(port), host: "LocalHost", recipients: ["someone@example.test"] },
      });

      expect(result.status).toBe(200);
    });

    it("stays through an edit that keeps the server, and is asked for again when the server changes", async () => {
      await allowPrivate();
      const port = await startSmtpStub();
      const id = await createMailChannel(port);

      const renamed = await edit(id, {
        ...leftEmpty(port),
        from: "alerts@example.test",
        recipients: ["team@example.test"],
      });
      expect(renamed.status).toBe(200);
      expect(storedPassword(id)).toBe("a-mail-password");

      const moved = await edit(id, { ...leftEmpty(port), host: "localhost" });
      expect(moved.status).toBe(400);
      expect(apiErrorOf(moved)).toMatchObject({
        code: "secret_destination_changed",
        fields: { password: "Enter the password for this server again" },
      });
      expect(repo.findChannel(context.deps.db, id)?.config.host).toBe("127.0.0.1");

      const retyped = await edit(id, { ...leftEmpty(port), host: "localhost", password: "a-new-password" });
      expect(retyped.status).toBe(200);
      expect(retyped.body.target).toBe(`localhost:${port}`);
      expect(storedPassword(id)).toBe("a-new-password");
    });

    it("is dropped when the channel stops signing in", async () => {
      await allowPrivate();
      const port = await startSmtpStub();
      const id = await createMailChannel(port);

      const unsigned = await edit(id, { ...leftEmpty(port), username: "" });

      expect(unsigned.status).toBe(200);
      expect(unsigned.body.hasSecret).toBe(false);
      expect(storedPassword(id)).toBeUndefined();
    });
  });
});

describe("delivery", () => {
  it("retries a bounded number of times and keeps one event identifier", async () => {
    await allowPrivate();
    const url = await startStub();
    const created = await post<NotificationChannel>("/api/v1/notifications/channels", channel(url));
    respond = (res, attempt) => {
      if (attempt < 3) {
        res.writeHead(500).end("nope");
      } else {
        res.writeHead(200).end("ok");
      }
    };
    const row = repo.findChannel(context.deps.db, created.body.id) as repo.ChannelRow;
    await deliverToChannel(
      context.deps,
      row,
      { id: "evt-retry", name: "deploy", title: "Deployment", body: "" },
      { sleep: async () => {} },
    );
    const deliveries = await call<NotificationDeliveryList>(context.app, "/api/v1/notifications/deliveries", {
      cookie,
    });
    expect(deliveries.body.deliveries).toHaveLength(1);
    expect(deliveries.body.deliveries[0]).toMatchObject({
      eventId: "evt-retry",
      attempts: 3,
      status: "sent",
      lastError: null,
    });
    expect(received).toHaveLength(3);
  });

  it("does not deliver the same event twice", async () => {
    await allowPrivate();
    const url = await startStub();
    await post("/api/v1/notifications/channels", channel(url));
    const event = { id: "evt-dup", name: "deploy" as const, title: "Deployment", body: "" };
    emitEvent(context.deps, event, { sleep: async () => {} });
    emitEvent(context.deps, event, { sleep: async () => {} });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toHaveLength(1);
  });

  it("gives up after its retries without touching what it reports on", async () => {
    await allowPrivate();
    const url = await startStub();
    respond = (res) => res.writeHead(500).end("nope");
    const created = await post<NotificationChannel>("/api/v1/notifications/channels", channel(url));
    const row = repo.findChannel(context.deps.db, created.body.id) as repo.ChannelRow;
    await deliverToChannel(
      context.deps,
      row,
      { id: "evt-fail", name: "deploy", title: "x", body: "" },
      { sleep: async () => {} },
    );
    const delivery = repo.listDeliveries(context.deps.db)[0];
    expect(delivery).toMatchObject({ status: "failed", attempts: 3 });
    expect(received).toHaveLength(3);
  });
});
