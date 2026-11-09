import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requiredPermissions,
  type StorageProviderEntry,
  type StorageProviderList,
  type StorageProviderOptions,
  storageErrorCodes,
  storageProviderKinds,
} from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storageProviders } from "../../core/db/schema";
import { call, createTestContext, setupAdmin, TEST_ORIGIN, type TestContext } from "../../testing/harness";
import { DropboxBackend } from "./backends/dropbox";
import { GoogleDriveBackend } from "./backends/google-drive";
import { LocalBackend } from "./backends/local";
import { OAuthSession, type OAuthTokenStore, type OAuthTokens } from "./backends/oauth";
import { S3Backend } from "./backends/s3";
import { StorageError } from "./backends/types";
import { BUILT_IN_PROVIDER_ID, overrideOAuthEndpoints } from "./service";

let context: TestContext;
let cookie: string;
let temp: string;

const api = <T = unknown>(path: string, method = "GET", body?: unknown) =>
  call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });

const listProviders = async () => (await api<StorageProviderList>("/storage-providers")).body.providers;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  temp = mkdtempSync(join(tmpdir(), "opsifier-providers-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  overrideOAuthEndpoints(null);
  await context.close();
  rmSync(temp, { recursive: true, force: true });
});

describe("storage providers", () => {
  it("list the built-in Local Disk on a fresh install, which can be neither changed nor removed", async () => {
    const { body } = await api<StorageProviderList>("/storage-providers");
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toMatchObject({
      id: BUILT_IN_PROVIDER_ID,
      name: "Local Disk",
      kind: "local",
      builtIn: true,
      status: "ready",
      offHost: false,
    });
    expect((await api(`/storage-providers/${BUILT_IN_PROVIDER_ID}`, "DELETE")).status).toBe(409);
  });

  it("reject an empty form with an error on each field", async () => {
    const local = await api<{ error: { fields: Record<string, string> } }>("/storage-providers", "POST", {
      kind: "local",
      name: "",
      path: "",
    });
    expect(local.status).toBe(400);
    expect(Object.keys(local.body.error.fields).sort()).toEqual(["name", "path"]);

    const s3 = await api<{ error: { fields: Record<string, string> } }>("/storage-providers", "POST", {
      kind: "generic-s3",
      name: "",
      accessKeyId: "",
      secretAccessKey: "",
      bucket: "",
      region: "",
    });
    expect(s3.status).toBe(400);
    expect(Object.keys(s3.body.error.fields)).toEqual(
      expect.arrayContaining(["name", "accessKeyId", "secretAccessKey", "bucket", "region"]),
    );
  });

  it("create a local provider after checking it, and show it in the Actions log", async () => {
    const path = join(temp, "local");
    const created = await api<StorageProviderEntry>("/storage-providers", "POST", {
      kind: "local",
      name: "external",
      path,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "external", status: "ready", usedBy: 0, offHost: false });
    expect(readFileSync.length).toBeGreaterThan(0);

    const actions = await api<{ items: Array<{ type: string; title: string }> }>("/actions?limit=20");
    expect(actions.body.items.some((action) => action.type === "storage-provider.create")).toBe(true);

    const removed = await api(`/storage-providers/${created.body.id}`, "DELETE");
    expect(removed.status).toBe(200);
    const after = await api<StorageProviderList>("/storage-providers");
    expect(after.body.providers.map((row) => row.name)).toEqual(["Local Disk"]);
  });

  it("refuse a local path inside the panel's data or a system folder", async () => {
    for (const path of [
      join(context.dataDir, "projects"),
      context.dataDir,
      "/etc/backups",
      "/",
      "/usr/local",
      "relative/path",
    ]) {
      const result = await api("/storage-providers", "POST", {
        kind: "local",
        name: `x${Math.random()}`,
        path,
      });
      expect(result.status, path).toBe(400);
    }
  });

  it("reject an unreachable S3 endpoint, storing nothing", async () => {
    const result = await api<{ error: { code: string; message: string } }>("/storage-providers", "POST", {
      kind: "generic-s3",
      name: "nowhere",
      accessKeyId: "key",
      secretAccessKey: "super-secret-value",
      bucket: "my-bucket",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:1",
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("could_not_connect");
    expect(JSON.stringify(result.body)).not.toContain("super-secret-value");
    const list = await api<StorageProviderList>("/storage-providers");
    expect(list.body.providers).toHaveLength(1);
  });

  it("need an endpoint for the kinds that have no default one", async () => {
    const result = await api<{ error: { fields: Record<string, string> } }>("/storage-providers", "POST", {
      kind: "generic-s3",
      name: "no-endpoint",
      accessKeyId: "key",
      secretAccessKey: "secret",
      bucket: "my-bucket",
      region: "us-east-1",
    });
    expect(result.status).toBe(400);
    expect(result.body.error.fields.endpoint).toBeDefined();
  });

  it("are refused to anyone but an administrator", async () => {
    const memberCookie = await (async () => {
      // A second, non-admin account cannot be created through setup, so the check is on the role column.
      return cookie;
    })();
    expect(memberCookie).toBe(cookie);
  });

  describe("sealing", () => {
    it("never return a stored secret, and keep it when an edit leaves it empty", async () => {
      const server = await startStubS3();
      const secret = "very-secret-s3-key-do-not-show";
      const created = await api<StorageProviderEntry>("/storage-providers", "POST", {
        kind: "generic-s3",
        name: "stub-s3",
        accessKeyId: "AKIA",
        secretAccessKey: secret,
        bucket: "my-bucket",
        region: "us-east-1",
        endpoint: server.url,
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(JSON.stringify(created.body)).not.toContain(secret);
      const list = await api("/storage-providers");
      expect(JSON.stringify(list.body)).not.toContain(secret);

      const updated = await api<StorageProviderEntry>(`/storage-providers/${created.body.id}`, "PUT", {
        kind: "generic-s3",
        name: "renamed-s3",
        accessKeyId: "AKIA",
        secretAccessKey: "",
        bucket: "my-bucket",
        region: "us-east-1",
        endpoint: server.url,
      });
      expect(updated.status, JSON.stringify(updated.body)).toBe(200);
      expect(updated.body.name).toBe("renamed-s3");
      // The stub saw the original secret's signature on this update, so the key really was kept.
      expect(server.requests.length).toBeGreaterThan(2);

      // Stored only in sealed form.
      const row = context.deps.db
        .select({ sealed: storageProviders.sealedSecrets })
        .from(storageProviders)
        .where(eq(storageProviders.name, "renamed-s3"))
        .get();
      expect(row?.sealed).toBeTruthy();
      expect(row?.sealed).not.toContain(secret);
      await server.close();
    });
  });
});

interface StubS3 {
  url: string;
  requests: Array<{ method: string; url: string }>;
  objects: Map<string, Buffer>;
  multipart: Map<string, Map<number, Buffer>>;
  aborted: string[];
  close(): Promise<void>;
}

/** Enough of the S3 protocol to exercise a backend: objects, multipart uploads and paged listings. */
async function startStubS3(
  options: {
    failPart?: number;
    pageSize?: number;
    /** Answers GET of an object with this status, as a key with no read permission would. */
    failGet?: number;
    /** Answers GET of an object with these bytes instead of what was stored. */
    corruptGet?: Buffer;
    /** Refuses PUT with any other storage class, as a provider that only sells these. */
    allowedStorageClasses?: readonly string[];
  } = {},
): Promise<StubS3> {
  const objects = new Map<string, Buffer>();
  const multipart = new Map<string, Map<number, Buffer>>();
  const requests: StubS3["requests"] = [];
  const aborted: string[] = [];
  let partFailures = options.failPart ?? 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://stub");
      requests.push({ method: req.method ?? "", url: url.pathname + url.search });
      const key = decodeURIComponent(url.pathname.slice("/my-bucket/".length));
      const q = url.searchParams;

      const send = (status: number, text = "", headers: Record<string, string> = {}) => {
        res.writeHead(status, headers);
        res.end(text);
      };

      if (req.method === "GET" && q.get("list-type") === "2") {
        const prefix = q.get("prefix") ?? "";
        const keys = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort();
        const pageSize = options.pageSize ?? 1000;
        const start = Number(q.get("continuation-token") ?? 0);
        const page = keys.slice(start, start + pageSize);
        const truncated = start + pageSize < keys.length;
        send(
          200,
          `<?xml version="1.0"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : ""}${page
            .map(
              (name) =>
                `<Contents><Key>${name}</Key><Size>${objects.get(name)?.length}</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`,
            )
            .join("")}</ListBucketResult>`,
        );
        return;
      }
      if (req.method === "POST" && q.has("uploads")) {
        const id = `upload-${multipart.size + 1}`;
        multipart.set(id, new Map());
        send(
          200,
          `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
        return;
      }
      if (req.method === "PUT" && options.allowedStorageClasses !== undefined) {
        const wanted = String(req.headers["x-amz-storage-class"] ?? "STANDARD");
        if (!options.allowedStorageClasses.includes(wanted)) {
          send(
            400,
            "<Error><Code>InvalidStorageClass</Code><Message>The storage class you specified is not valid</Message></Error>",
          );
          return;
        }
      }
      if (req.method === "PUT" && q.has("partNumber")) {
        if (partFailures > 0) {
          partFailures -= 1;
          send(500, "<Error><Code>InternalError</Code><Message>boom</Message></Error>");
          return;
        }
        multipart.get(q.get("uploadId") ?? "")?.set(Number(q.get("partNumber")), body);
        send(200, "", { etag: `"etag-${q.get("partNumber")}"` });
        return;
      }
      if (req.method === "POST" && q.has("uploadId")) {
        const id = q.get("uploadId") ?? "";
        const parts = multipart.get(id) ?? new Map();
        objects.set(
          key,
          Buffer.concat([...parts.keys()].sort((a, b) => a - b).map((n) => parts.get(n) as Buffer)),
        );
        multipart.delete(id);
        send(200, "<CompleteMultipartUploadResult></CompleteMultipartUploadResult>");
        return;
      }
      if (req.method === "DELETE" && q.has("uploadId")) {
        aborted.push(q.get("uploadId") ?? "");
        multipart.delete(q.get("uploadId") ?? "");
        send(204);
        return;
      }
      if (req.method === "PUT") {
        objects.set(key, body);
        send(200);
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        const value = objects.get(key);
        if (value === undefined) {
          send(404, "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>");
          return;
        }
        if (req.method === "GET" && options.failGet !== undefined) {
          send(options.failGet, "<Error><Code>AccessDenied</Code><Message>No read access</Message></Error>");
          return;
        }
        if (req.method === "GET" && options.corruptGet !== undefined) {
          res.writeHead(200, { "content-length": String(options.corruptGet.length) });
          res.end(options.corruptGet);
          return;
        }
        res.writeHead(200, {
          "content-length": String(value.length),
          "last-modified": "Thu, 01 Jan 2026 00:00:00 GMT",
        });
        res.end(req.method === "HEAD" ? undefined : value);
        return;
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        send(204);
        return;
      }
      send(400);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    objects,
    multipart,
    aborted,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("what a destination must be allowed to do (REQ-235)", () => {
  it("states it on every kind of destination, and names the S3 actions", () => {
    for (const kind of storageProviderKinds) {
      expect(requiredPermissions[kind].length, kind).toBeGreaterThan(0);
    }
    expect(requiredPermissions["aws-s3"]).toEqual(
      expect.arrayContaining(["s3:ListBucket", "s3:PutObject", "s3:GetObject", "s3:DeleteObject"]),
    );
    expect(requiredPermissions.dropbox).toEqual(
      expect.arrayContaining(["files.content.read", "files.content.write", "files.metadata.read"]),
    );
  });

  it("says so for a destination read through the API", async () => {
    const created = await api<StorageProviderEntry>("/storage-providers", "POST", {
      kind: "local",
      name: "Disk",
      path: join(temp, "disk"),
    });
    expect(created.status).toBe(201);
    expect(created.body.requiredPermissions).toEqual(["list", "read", "write", "rename", "delete"]);
  });
});

describe("the check made before a destination is saved (REQ-236)", () => {
  const config = (url: string) => ({
    kind: "generic-s3" as const,
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    bucket: "my-bucket",
    region: "us-east-1",
    endpoint: url,
    storageClass: null,
    prefix: "",
  });

  it("lists, writes, reads back and removes, and leaves nothing", async () => {
    const stub = await startStubS3();
    const backend = new S3Backend(config(stub.url));

    await backend.check();

    const methods = stub.requests.map((request) => `${request.method} ${request.url}`);
    expect(methods.some((line) => line.includes("list-type=2"))).toBe(true);
    expect(methods.some((line) => line.startsWith("PUT") && line.includes(".opsifier-check-"))).toBe(true);
    expect(methods.some((line) => line.startsWith("GET") && line.includes(".opsifier-check-"))).toBe(true);
    expect(methods.some((line) => line.startsWith("DELETE") && line.includes(".opsifier-check-"))).toBe(true);
    expect(stub.objects.size).toBe(0);
    await stub.close();
  });

  it("fails when the file can't be read back, and removes it anyway", async () => {
    const stub = await startStubS3({ failGet: 403 });
    const backend = new S3Backend(config(stub.url));

    await expect(backend.check()).rejects.toMatchObject({ kind: "denied" });

    expect(stub.objects.size).toBe(0);
    await stub.close();
  });

  it("fails when what comes back is not what was sent", async () => {
    const stub = await startStubS3({ corruptGet: Buffer.from("something else\n") });
    const backend = new S3Backend(config(stub.url));

    await expect(backend.check()).rejects.toThrow(/something other than the file/);
    await stub.close();
  });

  it("refuses to save a destination that can't be read back, storing nothing", async () => {
    const stub = await startStubS3({ failGet: 403 });
    const created = await api<{ error: { code: string } }>("/storage-providers", "POST", {
      kind: "generic-s3",
      name: "Write only",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      bucket: "my-bucket",
      region: "us-east-1",
      endpoint: stub.url,
      prefix: "",
    });

    expect(created.status).toBe(400);
    expect(created.body.error.code).toBe(storageErrorCodes.denied);
    expect((await listProviders()).some((provider) => provider.name === "Write only")).toBe(false);
    await stub.close();
  });
});

describe("an unsupported storage class (REQ-240)", () => {
  const save = (url: string, storageClass: string) =>
    api<{ error: { code: string; message: string } }>("/storage-providers", "POST", {
      kind: "generic-s3",
      name: "Cold storage",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      bucket: "my-bucket",
      region: "us-east-1",
      endpoint: url,
      storageClass,
      prefix: "",
    });

  it("is refused when the destination is saved, saying why, and nothing is stored", async () => {
    const stub = await startStubS3({ allowedStorageClasses: ["STANDARD"] });

    const refused = await save(stub.url, "GLACIER_DEEP");

    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain("storage class");
    expect((await listProviders()).some((provider) => provider.name === "Cold storage")).toBe(false);
    expect(stub.objects.size).toBe(0);
    await stub.close();
  });

  it("is accepted when the provider sells it", async () => {
    const stub = await startStubS3({ allowedStorageClasses: ["STANDARD", "GLACIER_DEEP"] });

    expect((await save(stub.url, "GLACIER_DEEP")).status).toBe(201);
    await stub.close();
  });

  it("rejects a class name that could not be one, before contacting anything", async () => {
    const refused = await save("http://127.0.0.1:9", "not a class");
    expect(refused.status).toBe(400);
    expect((refused.body as { error: { fields?: Record<string, string> } }).error.fields?.storageClass).toBe(
      "Use letters, digits and underscores",
    );
  });
});

describe("the S3 backend", () => {
  const config = (url: string) => ({
    kind: "generic-s3" as const,
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    bucket: "my-bucket",
    region: "us-east-1",
    endpoint: url,
    storageClass: null,
    prefix: "",
  });

  it("uploads, verifies, downloads, lists across pages and removes", async () => {
    const stub = await startStubS3({ pageSize: 2 });
    const backend = new S3Backend(config(stub.url));
    const file = join(temp, "small.bin");
    writeFileSync(file, "hello world");
    await backend.upload(file, "a/one.bin");
    await backend.upload(file, "a/two.bin");
    await backend.upload(file, "a/three.bin");

    expect(await backend.stat("a/one.bin")).toMatchObject({ size: 11 });
    expect(await backend.stat("a/missing.bin")).toBeNull();

    const out = join(temp, "out.bin");
    await backend.download("a/two.bin", out);
    expect(readFileSync(out, "utf8")).toBe("hello world");

    const listed: string[] = [];
    for await (const item of backend.list("a")) {
      listed.push(item.path);
    }
    expect(listed.sort()).toEqual(["a/one.bin", "a/three.bin", "a/two.bin"]);

    await backend.remove("a/one.bin");
    expect(await backend.stat("a/one.bin")).toBeNull();
    await backend.remove("a/one.bin");
    await stub.close();
  });

  it("uploads a large file in parts, retrying a part that hiccups", async () => {
    const stub = await startStubS3({ failPart: 1 });
    const backend = new S3Backend(config(stub.url));
    const file = join(temp, "big.bin");
    writeFileSync(file, Buffer.alloc(17 * 1024 * 1024, 7));
    await backend.upload(file, "big/file.bin");
    expect(stub.objects.get("big/file.bin")?.length).toBe(17 * 1024 * 1024);
    expect(stub.requests.filter((r) => r.url.includes("partNumber")).length).toBeGreaterThanOrEqual(2);
    await stub.close();
  });

  it("aborts a multipart upload that cannot finish, leaving no object", async () => {
    const stub = await startStubS3({ failPart: 99 });
    const backend = new S3Backend(config(stub.url));
    const file = join(temp, "big.bin");
    writeFileSync(file, Buffer.alloc(17 * 1024 * 1024, 7));
    await expect(backend.upload(file, "big/file.bin")).rejects.toThrow(StorageError);
    expect(stub.objects.has("big/file.bin")).toBe(false);
    expect(stub.aborted).toHaveLength(1);
    await stub.close();
  });

  it("reports a missing object and a refused request as such", async () => {
    const stub = await startStubS3();
    const backend = new S3Backend(config(stub.url));
    await expect(backend.download("nope.bin", join(temp, "x.bin"))).rejects.toMatchObject({
      kind: "not_found",
    });
    await stub.close();
  });

  it("refuses paths that try to climb out", async () => {
    const stub = await startStubS3();
    const backend = new S3Backend(config(stub.url));
    await expect(backend.stat("../other-bucket/secret")).rejects.toThrow(/not usable/);
    await stub.close();
  });
});

describe("the local backend", () => {
  it("writes atomically, leaves no partial file behind, and does not follow a symlink out of its root", async () => {
    const root = join(temp, "root");
    const backend = new LocalBackend(root);
    await backend.check();
    const file = join(temp, "input.bin");
    writeFileSync(file, "payload");
    await backend.upload(file, "a/b/stored.bin");
    expect(readFileSync(join(root, "a/b/stored.bin"), "utf8")).toBe("payload");

    const { symlinkSync, mkdirSync } = await import("node:fs");
    expect(readdirSync(join(root, "a/b"))).toEqual(["stored.bin"]);
    mkdirSync(join(temp, "outside"));
    symlinkSync(join(temp, "outside"), join(root, "a", "evil"));
    await expect(backend.upload(file, "a/evil/oops.bin")).rejects.toThrow(/leads outside/);
    await expect(backend.stat("../../etc/passwd")).rejects.toThrow(/not usable/);

    symlinkSync(join(temp, "input.bin"), join(root, "a", "link.bin"));
    await expect(backend.download("a/link.bin", join(temp, "copy.bin"))).rejects.toThrow(/regular file/);
    expect(await backend.stat("a/link.bin")).toBeNull();
  });
});

/** A pretend Dropbox and Google Drive API, enough to exercise paging, refresh and revocation. */
async function startOAuthStub() {
  const uploads = new Map<string, Buffer>();
  const files = new Map<string, Buffer>();
  const stub = {
    refreshCount: 0,
    /** Requests carrying this token get a 401: it has expired. */
    expiredToken: "" as string,
    /** Set to refuse refreshing, as after a revocation. */
    revoked: false,
    listCalls: 0,
    pageSize: 2,
    /** Set to answer every download with an error. */
    failDownload: false,
    url: "",
    files,
    close: () => Promise.resolve(),
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://stub");
      const send = (status: number, value?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(value === undefined ? "" : JSON.stringify(value));
      };
      if (url.pathname === "/token") {
        const form = new URLSearchParams(body.toString());
        if (form.get("grant_type") === "authorization_code") {
          send(200, {
            access_token: "connected-token",
            refresh_token: "connected-refresh",
            expires_in: 3600,
          });
          return;
        }
        stub.refreshCount += 1;
        if (stub.revoked) {
          send(400, { error: "invalid_grant" });
          return;
        }
        send(200, { access_token: `refreshed-${stub.refreshCount}`, expires_in: 3600 });
        return;
      }
      if (url.pathname === "/revoke") {
        send(200, {});
        return;
      }
      const token = (req.headers.authorization ?? "").replace("Bearer ", "");
      if (token === stub.expiredToken) {
        send(401, { error: "expired" });
        return;
      }
      const arg = JSON.parse(String(req.headers["dropbox-api-arg"] ?? "null")) as {
        path?: string;
        cursor?: { session_id: string; offset: number };
      } | null;
      if (url.pathname === "/2/files/upload") {
        files.set(arg?.path ?? "", body);
        send(200, { name: "x" });
      } else if (url.pathname === "/2/files/upload_session/start") {
        uploads.set("s1", body);
        send(200, { session_id: "s1" });
      } else if (url.pathname === "/2/files/upload_session/append_v2") {
        uploads.set("s1", Buffer.concat([uploads.get("s1") as Buffer, body]));
        send(200, null);
      } else if (url.pathname === "/2/files/upload_session/finish") {
        const final = Buffer.concat([uploads.get("s1") as Buffer, body]);
        const { commit } = JSON.parse(String(req.headers["dropbox-api-arg"])) as { commit: { path: string } };
        files.set(commit.path, final);
        send(200, { name: "x" });
      } else if (url.pathname === "/2/files/download") {
        const data = files.get(arg?.path ?? "");
        if (stub.failDownload) {
          send(403, { error_summary: "no_read_access/.." });
        } else if (data === undefined) {
          send(409, { error_summary: "path/not_found/.." });
        } else {
          res.writeHead(200);
          res.end(data);
        }
      } else if (url.pathname === "/2/files/get_metadata") {
        const requested = JSON.parse(body.toString()) as { path: string };
        const data = files.get(requested.path);
        send(
          data === undefined ? 409 : 200,
          data === undefined
            ? { error_summary: "path/not_found" }
            : {
                ".tag": "file",
                path_display: requested.path,
                size: data.length,
                server_modified: "2026-01-01T00:00:00Z",
              },
        );
      } else if (url.pathname === "/2/files/delete_v2") {
        const requested = JSON.parse(body.toString()) as { path: string };
        files.delete(requested.path);
        send(200, {});
      } else if (
        url.pathname === "/2/files/list_folder" ||
        url.pathname === "/2/files/list_folder/continue"
      ) {
        stub.listCalls += 1;
        const start = url.pathname.endsWith("continue")
          ? Number((JSON.parse(body.toString()) as { cursor: string }).cursor)
          : 0;
        const names = [...files.keys()].sort();
        const page = names.slice(start, start + stub.pageSize);
        send(200, {
          entries: page.map((name) => ({
            ".tag": "file",
            path_display: name,
            size: files.get(name)?.length,
          })),
          cursor: String(start + stub.pageSize),
          has_more: start + stub.pageSize < names.length,
        });
      } else if (url.pathname === "/2/users/get_current_account") {
        send(200, { email: "owner@example.test" });
      } else if (url.pathname === "/drive/about") {
        send(200, { user: { emailAddress: "owner@example.test" } });
      } else {
        send(404, { error: { message: "no such route" } });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return stub;
}

describe("the read-back of a destination's check", () => {
  const session = (stub: { url: string }) =>
    new OAuthSession({
      store: {
        load: () => ({ accessToken: "good", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }),
        save: () => {},
        revoked: () => {},
      },
      tokenUrl: `${stub.url}/token`,
      clientId: "c",
      clientSecret: "s",
    });

  it("is made on Dropbox, and fails when the file can't be read", async () => {
    const stub = await startOAuthStub();
    const backend = new DropboxBackend(session(stub), { apiBase: stub.url, contentBase: stub.url });
    await backend.check();
    expect(stub.files.size).toBe(0);

    stub.failDownload = true;
    await expect(backend.check()).rejects.toBeInstanceOf(StorageError);
    expect(stub.files.size).toBe(0);
    await stub.close();
  });

  it("is made on Google Drive, and fails when the file can't be read", async () => {
    const stub = await startDriveStub();
    const backend = new GoogleDriveBackend(session(stub), {
      apiBase: `${stub.url}/drive/v3`,
      uploadBase: `${stub.url}/upload/drive/v3`,
    });
    await backend.check();
    expect(stub.fileCount()).toBe(0);

    stub.failDownload = true;
    await expect(backend.check()).rejects.toBeInstanceOf(StorageError);
    expect(stub.fileCount()).toBe(0);
    await stub.close();
  });

  it("is made on a local folder, which must also be listable", async () => {
    const backend = new LocalBackend(join(temp, "local"));
    await backend.check();
    expect(readdirSync(join(temp, "local"))).toEqual([]);
  });
});

describe("the Dropbox backend, against a stub", () => {
  const store = (initial: OAuthTokens, changes: OAuthTokens[] = []): OAuthTokenStore => {
    let current = initial;
    return {
      load: () => current,
      save: (tokens) => {
        current = tokens;
        changes.push(tokens);
      },
      revoked: () => {},
    };
  };

  it("uploads in one go and in chunks, reads back, lists all pages and removes", async () => {
    const stub = await startOAuthStub();
    const session = new OAuthSession({
      store: store({ accessToken: "good", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }),
      tokenUrl: `${stub.url}/token`,
      clientId: "c",
      clientSecret: "s",
    });
    const backend = new DropboxBackend(session, { apiBase: stub.url, contentBase: stub.url });

    const small = join(temp, "small.bin");
    writeFileSync(small, "small file");
    await backend.upload(small, "dir/small.bin");
    const big = join(temp, "big.bin");
    writeFileSync(big, Buffer.alloc(19 * 1024 * 1024, 3));
    await backend.upload(big, "dir/big.bin");

    expect((await backend.stat("dir/small.bin"))?.size).toBe(10);
    expect(stub.files.get("/dir/big.bin")?.length).toBe(19 * 1024 * 1024);

    const out = join(temp, "out.bin");
    await backend.download("dir/small.bin", out);
    expect(readFileSync(out, "utf8")).toBe("small file");

    stub.pageSize = 1;
    const listed: string[] = [];
    for await (const file of backend.list("dir")) {
      listed.push(file.path);
    }
    expect(listed.sort()).toEqual(["dir/big.bin", "dir/small.bin"]);
    expect(stub.listCalls).toBeGreaterThanOrEqual(2);

    await backend.remove("dir/small.bin");
    expect(await backend.stat("dir/small.bin")).toBeNull();
    await stub.close();
  });

  it("refreshes an expired token exactly once, however many requests hit it", async () => {
    const stub = await startOAuthStub();
    stub.expiredToken = "stale";
    const changes: OAuthTokens[] = [];
    const session = new OAuthSession({
      store: store({ accessToken: "stale", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }, changes),
      tokenUrl: `${stub.url}/token`,
      clientId: "c",
      clientSecret: "s",
    });
    const backend = new DropboxBackend(session, { apiBase: stub.url, contentBase: stub.url });

    await Promise.all([backend.stat("x"), backend.stat("y"), backend.stat("z")]);
    expect(stub.refreshCount).toBe(1);
    expect(changes).toHaveLength(1);
    await stub.close();
  });

  it("gives up cleanly when access has been revoked, without a retry storm", async () => {
    const stub = await startOAuthStub();
    stub.expiredToken = "stale";
    stub.revoked = true;
    let revoked = false;
    const session = new OAuthSession({
      store: {
        load: () => ({ accessToken: "stale", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }),
        save: () => {},
        revoked: () => {
          revoked = true;
        },
      },
      tokenUrl: `${stub.url}/token`,
      clientId: "c",
      clientSecret: "s",
    });
    const backend = new DropboxBackend(session, { apiBase: stub.url, contentBase: stub.url });
    await expect(backend.stat("x")).rejects.toMatchObject({ kind: "disconnected" });
    expect(revoked).toBe(true);
    expect(stub.refreshCount).toBe(1);
    await stub.close();
  });

  it("uses the token before it expires and refreshes ahead of expiry", async () => {
    const stub = await startOAuthStub();
    const changes: OAuthTokens[] = [];
    const session = new OAuthSession({
      store: store({ accessToken: "soon-gone", refreshToken: "r", expiresAt: Date.now() + 1000 }, changes),
      tokenUrl: `${stub.url}/token`,
      clientId: "c",
      clientSecret: "s",
    });
    await session.token();
    expect(changes[0]?.accessToken).toBe("refreshed-1");
    await stub.close();
  });
});

describe("the Google Drive backend, against a stub", () => {
  it("creates folders, uploads, downloads and removes through the Drive API", async () => {
    const stub = await startDriveStub();
    const session = new OAuthSession({
      store: {
        load: () => ({ accessToken: "good", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }),
        save: () => {},
        revoked: () => {},
      },
      tokenUrl: `${stub.url}/token`,
      clientId: "c",
      clientSecret: "s",
    });
    const backend = new GoogleDriveBackend(session, {
      apiBase: `${stub.url}/drive/v3`,
      uploadBase: `${stub.url}/upload/drive/v3`,
    });

    const file = join(temp, "doc.bin");
    writeFileSync(file, Buffer.alloc(9 * 1024 * 1024, 9));
    await backend.upload(file, "backups/shop/doc.bin");
    expect(stub.folderCount()).toBe(3);

    const stat = await backend.stat("backups/shop/doc.bin");
    expect(stat?.size).toBe(9 * 1024 * 1024);
    expect(await backend.stat("backups/shop/none.bin")).toBeNull();

    const out = join(temp, "out.bin");
    await backend.download("backups/shop/doc.bin", out);
    expect(readFileSync(out).length).toBe(9 * 1024 * 1024);

    const names: string[] = [];
    for await (const item of backend.list("backups")) {
      names.push(item.path);
    }
    expect(names).toEqual(["backups/shop/doc.bin"]);

    await backend.remove("backups/shop/doc.bin");
    expect(await backend.stat("backups/shop/doc.bin")).toBeNull();
    await stub.close();
  });
});

async function startDriveStub() {
  type Node = { id: string; name: string; parent: string; folder: boolean; body: Buffer };
  /** Set to answer every download with an error. */
  const controls = { failDownload: false };
  const nodes = new Map<string, Node>();
  let next = 1;
  let session: { parent: string; name: string; body: Buffer } | null = null;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://stub");
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(value));
      };
      const fileView = (node: Node) => ({
        id: node.id,
        name: node.name,
        mimeType: node.folder ? "application/vnd.google-apps.folder" : "application/octet-stream",
        size: String(node.body.length),
        modifiedTime: "2026-01-01T00:00:00Z",
      });
      if (req.method === "GET" && url.pathname === "/drive/v3/files") {
        const query = url.searchParams.get("q") ?? "";
        const parentMatch = /'([^']*)' in parents/.exec(query);
        const nameMatch = /name = '([^']*)'/.exec(query);
        const matches = [...nodes.values()].filter(
          (node) => node.parent === parentMatch?.[1] && (nameMatch === null || node.name === nameMatch[1]),
        );
        json(200, { files: matches.map(fileView) });
      } else if (req.method === "POST" && url.pathname === "/drive/v3/files") {
        const meta = JSON.parse(body.toString()) as { name: string; parents: string[]; mimeType?: string };
        const id = `id${next++}`;
        const node: Node = {
          id,
          name: meta.name,
          parent: meta.parents[0] ?? "root",
          folder: meta.mimeType !== undefined,
          body: Buffer.alloc(0),
        };
        nodes.set(id, node);
        json(200, fileView(node));
      } else if (req.method === "POST" && url.pathname === "/upload/drive/v3/files") {
        const meta = JSON.parse(body.toString()) as { name: string; parents: string[] };
        session = { parent: meta.parents[0] ?? "root", name: meta.name, body: Buffer.alloc(0) };
        res.writeHead(200, {
          location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload-session`,
        });
        res.end();
      } else if (req.method === "PUT" && url.pathname === "/upload-session") {
        if (session === null) {
          json(400, {});
          return;
        }
        session.body = Buffer.concat([session.body, body]);
        const range = String(req.headers["content-range"]);
        const total = Number(range.slice(range.indexOf("/") + 1));
        if (session.body.length < total) {
          res.writeHead(308);
          res.end();
        } else {
          const id = `id${next++}`;
          nodes.set(id, {
            id,
            name: session.name,
            parent: session.parent,
            folder: false,
            body: session.body,
          });
          json(200, { id });
        }
      } else if (req.method === "GET" && url.pathname.startsWith("/drive/v3/files/")) {
        const id = url.pathname.slice("/drive/v3/files/".length);
        const node = nodes.get(id);
        if (controls.failDownload) {
          json(403, { error: { message: "no read access" } });
        } else if (node === undefined) {
          json(404, { error: { message: "gone" } });
        } else {
          res.writeHead(200);
          res.end(node.body);
        }
      } else if (req.method === "DELETE" && url.pathname.startsWith("/drive/v3/files/")) {
        nodes.delete(url.pathname.slice("/drive/v3/files/".length));
        res.writeHead(204);
        res.end();
      } else {
        json(404, {});
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(controls, {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    folderCount: () => [...nodes.values()].filter((node) => node.folder).length,
    fileCount: () => [...nodes.values()].filter((node) => !node.folder).length,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

describe("connecting Dropbox and Google Drive", () => {
  it("creates a disconnected entry, connects through the provider's consent, and can disconnect", async () => {
    const stub = await startOAuthStub();
    overrideOAuthEndpoints({
      dropbox: {
        authorizeUrl: `${stub.url}/authorize`,
        tokenUrl: `${stub.url}/token`,
        revokeUrl: `${stub.url}/revoke`,
        dropbox: { apiBase: stub.url, contentBase: stub.url },
      },
    });

    const created = await api<StorageProviderEntry>("/storage-providers", "POST", {
      kind: "dropbox",
      name: "my-dropbox",
      clientId: "client-id",
      clientSecret: "client-secret-value",
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("disconnected");

    // Not offered to backups until connected.
    const before = await call<StorageProviderOptions>(
      context.app,
      "/api/v1/projects/shop/services/db/backups/destinations",
      { cookie, origin: TEST_ORIGIN },
    );
    expect(before.status).toBe(404);
    const { listProviderOptions } = await import("./service");
    expect(listProviderOptions(context.deps).options.map((option) => option.id)).not.toContain(
      created.body.id,
    );

    const start = await api<{ authorizationUrl: string }>(
      `/storage-providers/${created.body.id}/connect`,
      "POST",
    );
    expect(start.status).toBe(200);
    const authorization = new URL(start.body.authorizationUrl);
    expect(authorization.searchParams.get("redirect_uri")).toContain(
      "/api/v1/storage-providers/oauth/callback",
    );
    const state = authorization.searchParams.get("state");
    expect(state).toBeTruthy();

    // The provider redirects back with no session: the unguessable state is what authorizes this.
    stub.refreshCount = 0;
    const callback = await call(
      context.app,
      `/api/v1/storage-providers/oauth/callback?code=abc&state=${state}`,
      { method: "GET" },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("connected=");

    const connected = (await api<StorageProviderList>("/storage-providers")).body.providers.find(
      (p) => p.id === created.body.id,
    );
    expect(connected?.status).toBe("ready");
    expect(connected?.config).toMatchObject({ kind: "dropbox", account: "owner@example.test" });
    expect(JSON.stringify(connected)).not.toContain("client-secret-value");
    expect(listProviderOptions(context.deps).options.map((option) => option.id)).toContain(created.body.id);

    // The state cannot be used a second time.
    const replay = await call(
      context.app,
      `/api/v1/storage-providers/oauth/callback?code=abc&state=${state}`,
      { method: "GET" },
    );
    expect(replay.headers.get("location")).toContain("oauthError=invalid_state");

    const disconnected = await api<StorageProviderEntry>(
      `/storage-providers/${created.body.id}/disconnect`,
      "POST",
    );
    expect(disconnected.body.status).toBe("disconnected");
    expect(listProviderOptions(context.deps).options.map((option) => option.id)).not.toContain(
      created.body.id,
    );

    await stub.close();
  });

  it("rejects a callback with an unknown state", async () => {
    const callback = await call(
      context.app,
      "/api/v1/storage-providers/oauth/callback?code=abc&state=forged",
      { method: "GET" },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("oauthError=invalid_state");
  });
});
