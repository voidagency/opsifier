import { createHash, createHmac } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { S3ProviderKind } from "@opsifier/contract";
import {
  assertRemotePath,
  isAbortError,
  networkMessage,
  type RemoteFile,
  type StorageBackend,
  StorageError,
  type TransferOptions,
  verifyRoundTrip,
  withRetries,
} from "./types";

export interface S3BackendConfig {
  kind: S3ProviderKind;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  endpoint: string | null;
  storageClass: string | null;
  prefix: string;
}

const MIN_PART_BYTES = 16 * 1024 * 1024;
const MAX_PARTS = 9000;
const REQUEST_TIMEOUT_MS = 60_000;
/** A part of the largest size allowed, over a slow link. */
const TRANSFER_TIMEOUT_MS = 30 * 60 * 1000;
const EMPTY_SHA256 = createHash("sha256").digest("hex");

const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

const hmac = (key: Buffer | string, value: string): Buffer =>
  createHmac("sha256", key).update(value, "utf8").digest();

/** `encodeURIComponent` leaves `!'()*` alone, and S3 canonicalizes them. */
function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const encodeKey = (key: string): string => key.split("/").map(encodeSegment).join("/");

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll("&amp;", "&");
}

/** The first value of a simple tag, which is all these flat documents need. */
function xmlValue(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match?.[1] === undefined ? null : decodeXml(match[1]);
}

function xmlBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map(
    (match) => match[1] ?? "",
  );
}

export function defaultEndpoint(kind: S3ProviderKind, region: string): string | null {
  switch (kind) {
    case "aws-s3":
      return `https://s3.${region}.amazonaws.com`;
    case "digitalocean-spaces":
      return `https://${region}.digitaloceanspaces.com`;
    case "backblaze-b2":
      return `https://s3.${region}.backblazeb2.com`;
    case "wasabi":
      return `https://s3.${region}.wasabisys.com`;
    default:
      return null;
  }
}

interface S3Response {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

interface RequestOptions {
  method: "GET" | "PUT" | "POST" | "DELETE" | "HEAD";
  key?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Buffer;
  /** The SHA-256 of `body`, already computed by the caller. */
  bodyHash?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  acceptStatuses?: readonly number[];
}

type S3Fetch = typeof fetch;

/** A hand-written SigV4 client for the few calls a destination needs. Every part is hashed and verified by the store. */
export class S3Backend implements StorageBackend {
  private readonly baseUrl: URL;
  private readonly virtualHosted: boolean;
  private readonly storageClass: string | null;

  constructor(
    private readonly config: S3BackendConfig,
    private readonly http: S3Fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    const endpoint = config.endpoint ?? defaultEndpoint(config.kind, config.region);
    if (endpoint === null) {
      throw new StorageError("failed", "This destination needs an endpoint.");
    }
    this.baseUrl = new URL(endpoint);
    // Only AWS serves every region both ways. A bucket with dots breaks the wildcard certificate.
    this.virtualHosted = config.kind === "aws-s3" && config.endpoint === null && !config.bucket.includes(".");
    this.storageClass = config.storageClass;
  }

  private objectKey(remotePath: string): string {
    return this.config.prefix === "" ? remotePath : `${this.config.prefix}/${remotePath}`;
  }

  private urlFor(key: string | undefined, query: string): { url: URL; canonicalPath: string } {
    const encodedKey = key === undefined ? "" : encodeKey(key);
    const search = query === "" ? "" : `?${query}`;
    if (this.virtualHosted) {
      const url = new URL(
        `${this.baseUrl.protocol}//${this.config.bucket}.${this.baseUrl.host}/${encodedKey}${search}`,
      );
      return { url, canonicalPath: `/${encodedKey}` };
    }
    const path =
      key === undefined
        ? `/${encodeSegment(this.config.bucket)}`
        : `/${encodeSegment(this.config.bucket)}/${encodedKey}`;
    return {
      url: new URL(`${this.baseUrl.protocol}//${this.baseUrl.host}${path}${search}`),
      canonicalPath: path,
    };
  }

  /** The SigV4 headers for one request. The URL is exactly what `fetch` will send. */
  private sign(
    method: string,
    url: URL,
    canonicalPath: string,
    canonicalQuery: string,
    payloadHash: string,
    extraHeaders: Record<string, string>,
  ): Record<string, string> {
    const timestamp = this.now()
      .toISOString()
      .replace(/[-:]|\.\d{3}/g, "");
    const date = timestamp.slice(0, 8);
    const signed: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": timestamp,
    };
    for (const [name, value] of Object.entries(extraHeaders)) {
      if (name.startsWith("x-amz-")) {
        signed[name] = value;
      }
    }
    const names = Object.keys(signed).sort();
    const canonicalHeaders = names.map((name) => `${name}:${signed[name]?.trim()}\n`).join("");
    const signedHeaderNames = names.join(";");
    const canonicalRequest = [
      method,
      canonicalPath,
      canonicalQuery,
      canonicalHeaders,
      signedHeaderNames,
      payloadHash,
    ].join("\n");

    const scope = `${date}/${this.config.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256Hex(canonicalRequest)].join("\n");
    const dateKey = hmac(`AWS4${this.config.secretAccessKey}`, date);
    const regionKey = hmac(dateKey, this.config.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

    return {
      ...extraHeaders,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": timestamp,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
    };
  }

  private canonicalQuery(query: Record<string, string>): string {
    return Object.keys(query)
      .sort()
      .map((name) => `${encodeSegment(name)}=${encodeSegment(query[name] ?? "")}`)
      .join("&");
  }

  private async send(options: RequestOptions): Promise<S3Response> {
    const { method, key, query = {}, headers = {}, body, signal, timeoutMs = REQUEST_TIMEOUT_MS } = options;
    const canonicalQuery = this.canonicalQuery(query);
    const { url, canonicalPath } = this.urlFor(key, canonicalQuery);
    const payloadHash = options.bodyHash ?? (body === undefined ? EMPTY_SHA256 : sha256Hex(body));
    const signedHeaders = this.sign(method, url, canonicalPath, canonicalQuery, payloadHash, headers);

    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await this.http(url, {
        method,
        headers: signedHeaders,
        body: body as RequestInit["body"],
        signal: combined,
      });
    } catch (error) {
      if (isAbortError(error) && signal?.aborted === true) {
        throw signal.reason ?? error;
      }
      if (isAbortError(error)) {
        throw new StorageError("unreachable", "The storage server did not answer in time.");
      }
      throw new StorageError("unreachable", networkMessage(error, "The storage server"));
    }

    const accepted = options.acceptStatuses ?? [200, 204];
    if (!accepted.includes(response.status)) {
      const text = await response.text().catch(() => "");
      throw this.toError(response.status, text);
    }
    return {
      status: response.status,
      headers: response.headers,
      body: response.body,
      text: () => response.text(),
    };
  }

  private toError(status: number, xml: string): StorageError {
    const code = xmlValue(xml, "Code") ?? "";
    const detail = xmlValue(xml, "Message") ?? code;
    const kind =
      status === 401 || status === 403 || code === "SignatureDoesNotMatch" || code === "InvalidAccessKeyId"
        ? "denied"
        : status === 404
          ? "not_found"
          : status >= 500 || status === 503
            ? "unreachable"
            : "failed";
    return new StorageError(
      kind,
      detail === "" ? `The storage server answered ${status}.` : `The storage server said: ${detail}`,
    );
  }

  private isRetryable(error: unknown): boolean {
    return error instanceof StorageError && error.kind === "unreachable";
  }

  async check(signal?: AbortSignal): Promise<void> {
    await this.send({
      method: "GET",
      query: {
        "list-type": "2",
        "max-keys": "1",
        ...(this.config.prefix === "" ? {} : { prefix: `${this.config.prefix}/` }),
      },
      signal,
    });
    await verifyRoundTrip(this, signal);
  }

  private storageHeaders(): Record<string, string> {
    return this.storageClass === null ? {} : { "x-amz-storage-class": this.storageClass };
  }

  private async put(key: string, body: Buffer, signal?: AbortSignal): Promise<void> {
    await withRetries(
      () =>
        this.send({
          method: "PUT",
          key,
          body,
          headers: this.storageHeaders(),
          signal,
          timeoutMs: TRANSFER_TIMEOUT_MS,
        }),
      this.isRetryable,
      signal,
    );
  }

  async upload(localPath: string, remotePath: string, options: TransferOptions = {}): Promise<void> {
    assertRemotePath(remotePath);
    const key = this.objectKey(remotePath);
    const handle = await open(localPath, "r");
    try {
      const { size } = await handle.stat();
      const partSize = Math.max(MIN_PART_BYTES, Math.ceil(size / MAX_PARTS));
      if (size <= partSize) {
        const body = Buffer.alloc(size);
        await handle.read(body, 0, size, 0);
        await this.put(key, body, options.signal);
        options.onProgress?.(size);
        return;
      }
      await this.uploadMultipart(handle, key, size, partSize, options);
    } finally {
      await handle.close();
    }
  }

  private async uploadMultipart(
    handle: Awaited<ReturnType<typeof open>>,
    key: string,
    size: number,
    partSize: number,
    options: TransferOptions,
  ): Promise<void> {
    const created = await this.send({
      method: "POST",
      key,
      query: { uploads: "" },
      headers: this.storageHeaders(),
      signal: options.signal,
    });
    const uploadId = xmlValue(await created.text(), "UploadId");
    if (uploadId === null) {
      throw new StorageError("failed", "The storage server did not start the upload.");
    }

    // A finished multipart upload is the only way the object appears, so an interrupted one leaves nothing.
    try {
      const parts: Array<{ number: number; etag: string }> = [];
      let offset = 0;
      let number = 1;
      const buffer = Buffer.allocUnsafe(partSize);
      while (offset < size) {
        const length = Math.min(partSize, size - offset);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead !== length) {
          throw new StorageError("failed", "The file changed while it was being uploaded.");
        }
        const body = buffer.subarray(0, length);
        const etag = await this.uploadPart(key, uploadId, number, body, options.signal);
        parts.push({ number, etag });
        offset += length;
        number += 1;
        options.onProgress?.(offset);
      }

      const completeBody = Buffer.from(
        `<CompleteMultipartUpload>${parts
          .map((part) => `<Part><PartNumber>${part.number}</PartNumber><ETag>${part.etag}</ETag></Part>`)
          .join("")}</CompleteMultipartUpload>`,
        "utf8",
      );
      const finished = await this.send({
        method: "POST",
        key,
        query: { uploadId },
        body: completeBody,
        signal: options.signal,
        timeoutMs: TRANSFER_TIMEOUT_MS,
      });
      // S3 answers 200 even when completing fails, with the error in the body.
      const text = await finished.text();
      if (text.includes("<Error>")) {
        throw this.toError(500, text);
      }
    } catch (error) {
      await this.send({ method: "DELETE", key, query: { uploadId }, acceptStatuses: [200, 204, 404] }).catch(
        () => {},
      );
      throw error;
    }
  }

  private async uploadPart(
    key: string,
    uploadId: string,
    number: number,
    body: Buffer,
    signal?: AbortSignal,
  ): Promise<string> {
    return withRetries(
      async () => {
        const response = await this.send({
          method: "PUT",
          key,
          query: { partNumber: String(number), uploadId },
          body,
          signal,
          timeoutMs: TRANSFER_TIMEOUT_MS,
        });
        const etag = response.headers.get("etag");
        if (etag === null) {
          throw new StorageError("failed", "The storage server did not confirm a part.");
        }
        return etag;
      },
      this.isRetryable,
      signal,
    );
  }

  async download(remotePath: string, localPath: string, options: TransferOptions = {}): Promise<void> {
    assertRemotePath(remotePath);
    const response = await this.send({
      method: "GET",
      key: this.objectKey(remotePath),
      signal: options.signal,
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
    if (response.body === null) {
      throw new StorageError("failed", "The storage server sent nothing.");
    }
    let transferred = 0;
    const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>).on("data", (chunk) => {
      transferred += chunk.length;
      options.onProgress?.(transferred);
    });
    try {
      await pipeline(body, createWriteStream(localPath, { mode: 0o600 }), { signal: options.signal });
    } catch (error) {
      await rm(localPath, { force: true }).catch(() => {});
      if (isAbortError(error)) {
        throw error;
      }
      throw new StorageError("unreachable", "The download was interrupted.");
    }
  }

  async stat(remotePath: string, signal?: AbortSignal): Promise<RemoteFile | null> {
    assertRemotePath(remotePath);
    const response = await this.send({
      method: "HEAD",
      key: this.objectKey(remotePath),
      signal,
      acceptStatuses: [200, 404],
    });
    if (response.status === 404) {
      return null;
    }
    const modified = response.headers.get("last-modified");
    return {
      path: remotePath,
      size: Number(response.headers.get("content-length") ?? 0),
      modifiedAt: modified === null ? null : new Date(modified),
    };
  }

  async *list(prefix: string, signal?: AbortSignal): AsyncIterable<RemoteFile> {
    assertRemotePath(prefix);
    const keyPrefix = `${this.objectKey(prefix)}/`;
    const trim = this.config.prefix === "" ? 0 : this.config.prefix.length + 1;
    let token: string | null = null;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix: keyPrefix };
      if (token !== null) {
        query["continuation-token"] = token;
      }
      const response: S3Response = await this.send({ method: "GET", query, signal });
      const xml = await response.text();
      for (const item of xmlBlocks(xml, "Contents")) {
        const key = xmlValue(item, "Key");
        if (key !== null) {
          const modified = xmlValue(item, "LastModified");
          yield {
            path: key.slice(trim),
            size: Number(xmlValue(item, "Size") ?? 0),
            modifiedAt: modified === null ? null : new Date(modified),
          };
        }
      }
      token = xmlValue(xml, "IsTruncated") === "true" ? xmlValue(xml, "NextContinuationToken") : null;
    } while (token !== null);
  }

  async remove(remotePath: string, signal?: AbortSignal): Promise<void> {
    assertRemotePath(remotePath);
    await withRetries(
      () =>
        this.send({
          method: "DELETE",
          key: this.objectKey(remotePath),
          signal,
          acceptStatuses: [200, 204, 404],
        }),
      this.isRetryable,
      signal,
    );
  }
}
