import { createHmac, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { connect as netConnect, type Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { DestinationError, resolveDestination } from "./destinations";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 8 * 1024;
const SMTP_TIMEOUT_MS = 15_000;

export interface OutgoingMessage {
  eventId: string;
  event: string;
  title: string;
  body: string;
  at: string;
}

export interface SenderOptions {
  allowPrivate: boolean;
  /** Where Telegram's API is. Only moved for tests. */
  telegramApi: string;
}

/** Removes a secret from anything that gets stored or shown. */
export function redact(text: string, secrets: ReadonlyArray<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== undefined && secret.length > 0) {
      out = out.split(secret).join("***");
    }
  }
  return out;
}

export class DeliveryError extends Error {
  override readonly name = "DeliveryError";
}

interface HttpResult {
  status: number;
  body: string;
}

/** One POST, to an address already checked, with no redirect followed and a bounded answer. */
async function post(
  url: string,
  body: string,
  headers: Record<string, string>,
  options: SenderOptions,
): Promise<HttpResult> {
  const target = new URL(url);
  let destination: Awaited<ReturnType<typeof resolveDestination>>;
  try {
    destination = await resolveDestination(target.hostname, { allowPrivate: options.allowPrivate });
  } catch (error) {
    throw new DeliveryError(
      error instanceof DestinationError ? error.message : "The destination could not be resolved.",
    );
  }

  // The lookup always answers with the address that was checked, so DNS cannot change its mind.
  const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    const done = callback as unknown as (
      error: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;
    if ((lookupOptions as { all?: boolean }).all === true) {
      done(null, [{ address: destination.address, family: destination.family }]);
    } else {
      done(null, destination.address, destination.family);
    }
  };

  return new Promise<HttpResult>((resolve, reject) => {
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
        timeout: REQUEST_TIMEOUT_MS,
        lookup,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received <= MAX_RESPONSE_BYTES) {
            chunks.push(chunk);
          } else {
            response.destroy();
          }
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
        response.on("error", (error) => reject(new DeliveryError(error.message)));
      },
    );
    request.on("timeout", () => {
      request.destroy(new DeliveryError("The destination did not answer in time."));
    });
    request.on("error", (error) => {
      reject(error instanceof DeliveryError ? error : new DeliveryError(error.message));
    });
    request.end(body);
  });
}

async function postOk(
  url: string,
  body: string,
  headers: Record<string, string>,
  options: SenderOptions,
): Promise<string> {
  const { status, body: answer } = await post(url, body, headers, options);
  // A redirect is not followed, so it counts as a failure rather than being silently lost.
  if (status < 200 || status >= 300) {
    throw new DeliveryError(
      `The destination answered ${status}${answer === "" ? "" : `: ${answer.slice(0, 200)}`}.`,
    );
  }
  return `HTTP ${status}`;
}

const plainText = (message: OutgoingMessage) => `${message.title}\n${message.body}`.trim();

export async function sendDiscord(
  webhookUrl: string,
  message: OutgoingMessage,
  options: SenderOptions,
): Promise<string> {
  return postOk(webhookUrl, JSON.stringify({ content: plainText(message).slice(0, 1900) }), {}, options);
}

export async function sendSlack(
  webhookUrl: string,
  message: OutgoingMessage,
  options: SenderOptions,
): Promise<string> {
  return postOk(webhookUrl, JSON.stringify({ text: plainText(message) }), {}, options);
}

export async function sendTelegram(
  botToken: string,
  chatId: string,
  message: OutgoingMessage,
  options: SenderOptions,
): Promise<string> {
  const url = `${options.telegramApi}/bot${botToken}/sendMessage`;
  return postOk(
    url,
    JSON.stringify({ chat_id: chatId, text: plainText(message).slice(0, 4000) }),
    {},
    options,
  );
}

export async function sendWebhook(
  url: string,
  secret: string | undefined,
  message: OutgoingMessage,
  options: SenderOptions,
): Promise<string> {
  const body = JSON.stringify(message);
  const headers: Record<string, string> = {};
  if (secret !== undefined && secret !== "") {
    headers["x-opsifier-signature"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  }
  return postOk(url, body, headers, options);
}

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string | undefined;
  from: string;
  recipients: readonly string[];
}

/** Line-based reply reading for one SMTP conversation. Multi-line replies end at "NNN ". */
class SmtpReader {
  private buffer = "";
  private readonly waiting: Array<(line: string) => void> = [];

  constructor(socket: Socket | TLSSocket) {
    this.attach(socket);
  }

  attach(socket: Socket | TLSSocket): void {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let index = this.buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.buffer.slice(0, index).replace(/\r$/, "");
        this.buffer = this.buffer.slice(index + 1);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          this.waiting.shift()?.(line);
        }
        index = this.buffer.indexOf("\n");
      }
    });
  }

  next(): Promise<string> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

function smtpEncode(message: OutgoingMessage, from: string, to: readonly string[]): string {
  const subject = Buffer.from(message.title, "utf8").toString("base64");
  const boundaryDate = new Date(message.at).toUTCString();
  return [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: =?UTF-8?B?${subject}?=`,
    `Date: ${boundaryDate}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@opsifier>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    message.body.replace(/\r?\n/g, "\r\n").replace(/^\./gm, ".."),
    ".",
    "",
  ].join("\r\n");
}

/** A small SMTP client: STARTTLS when offered, AUTH PLAIN, bounded by a timeout. */
export async function sendSmtp(
  config: SmtpConfig,
  message: OutgoingMessage,
  options: SenderOptions,
): Promise<string> {
  let destination: Awaited<ReturnType<typeof resolveDestination>>;
  try {
    destination = await resolveDestination(config.host, { allowPrivate: options.allowPrivate });
  } catch (error) {
    throw new DeliveryError(
      error instanceof DestinationError ? error.message : "The destination could not be resolved.",
    );
  }

  const smtps = config.port === 465;
  let socket: Socket | TLSSocket = smtps
    ? tlsConnect({ host: destination.address, port: config.port, servername: config.host })
    : netConnect({ host: destination.address, port: config.port, family: destination.family });
  socket.setTimeout(SMTP_TIMEOUT_MS);

  return await new Promise<string>((resolve, reject) => {
    const fail = (error: Error) => {
      socket.destroy();
      reject(error instanceof DeliveryError ? error : new DeliveryError(error.message));
    };
    socket.on("error", fail);
    socket.on("timeout", () => fail(new DeliveryError("The mail server did not answer in time.")));

    const reader = new SmtpReader(socket);
    const expect = async (code: number) => {
      const reply = await reader.next();
      if (!reply.startsWith(String(code))) {
        throw new DeliveryError(`The mail server answered: ${reply}`);
      }
      return reply;
    };
    const send = (line: string) => socket.write(`${line}\r\n`);
    const finish = () => {
      send("QUIT");
      socket.end();
    };

    void (async () => {
      await expect(220);
      send("EHLO opsifier");
      let reply = await reader.next();
      if (!reply.startsWith("250")) {
        throw new DeliveryError(`The mail server answered: ${reply}`);
      }

      let encrypted = smtps;
      if (!smtps) {
        send("STARTTLS");
        reply = await reader.next();
        if (reply.startsWith("220")) {
          const upgraded: TLSSocket = tlsConnect({ socket, servername: config.host });
          socket = upgraded;
          socket.on("error", fail);
          reader.attach(upgraded);
          await new Promise<void>((done) => upgraded.once("secureConnect", () => done()));
          encrypted = true;
          send("EHLO opsifier");
          await expect(250);
        }
      }

      if (config.username !== "") {
        if (!encrypted) {
          throw new DeliveryError("The mail server offers no encryption, so the password was not sent.");
        }
        const secret = Buffer.from(`\0${config.username}\0${config.password ?? ""}`).toString("base64");
        send(`AUTH PLAIN ${secret}`);
        await expect(235);
      }

      send(`MAIL FROM:<${config.from}>`);
      await expect(250);
      for (const recipient of config.recipients) {
        send(`RCPT TO:<${recipient}>`);
        await expect(250);
      }
      send("DATA");
      await expect(354);
      socket.write(smtpEncode(message, config.from, config.recipients));
      const accepted = await expect(250);
      finish();
      resolve(accepted);
    })().catch(fail);
  });
}
