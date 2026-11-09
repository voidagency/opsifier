import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { type SFTPWrapper, Server as SshServer, utils } from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FtpBackend } from "./ftp";
import { fingerprintOf, SftpBackend } from "./sftp";
import { StorageError } from "./types";

let temp: string;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "opsifier-ftp-sftp-"));
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

/** A small FTP server speaking enough of the protocol for `basic-ftp`, in passive mode. */
class FtpStub {
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>(["/"]);
  server!: Server;
  port = 0;
  rejectStore = false;
  rejectRead = false;

  constructor(private readonly password: string) {}

  async start(): Promise<void> {
    this.server = createServer((socket) => this.connection(socket));
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private connection(control: Socket): void {
    let cwd = "/";
    let dataServer: Server | undefined;
    let dataSocket: Promise<Socket> | undefined;
    let renameFrom: string | undefined;
    const send = (line: string) => control.write(`${line}\r\n`);
    const resolvePath = (path: string) =>
      path.startsWith("/") ? posix.normalize(path) : posix.join(cwd, path);

    const openPassive = async () => {
      dataServer = createServer((socket) => socket.on("error", () => {}));
      dataSocket = new Promise<Socket>((resolve) => dataServer?.once("connection", resolve));
      await new Promise<void>((resolve) => dataServer?.listen(0, "127.0.0.1", resolve));
      return (dataServer.address() as { port: number }).port;
    };

    let buffer = "";
    control.on("error", () => {});
    send("220 ready");
    control.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end === -1) {
          return;
        }
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        void this.handle(line, {
          send,
          control,
          cwd: () => cwd,
          setCwd: (value) => {
            cwd = value;
          },
          resolvePath,
          openPassive,
          data: () => dataSocket,
          renameFrom: () => renameFrom,
          setRenameFrom: (value) => {
            renameFrom = value;
          },
        });
      }
    });
  }

  private async handle(
    line: string,
    ctx: {
      send: (line: string) => void;
      control: Socket;
      cwd: () => string;
      setCwd: (value: string) => void;
      resolvePath: (path: string) => string;
      openPassive: () => Promise<number>;
      data: () => Promise<Socket> | undefined;
      renameFrom: () => string | undefined;
      setRenameFrom: (value: string | undefined) => void;
    },
  ): Promise<void> {
    const [command = "", ...rest] = line.split(" ");
    const arg = rest.join(" ");
    const { send, resolvePath } = ctx;
    switch (command.toUpperCase()) {
      case "USER":
        send("331 password please");
        break;
      case "PASS":
        send(arg === this.password ? "230 logged in" : "530 not logged in");
        break;
      case "TYPE":
        send("200 type set");
        break;
      case "OPTS":
        send("200 ok");
        break;
      case "FEAT":
        send("211-features\r\n MLST type*;size*;\r\n SIZE\r\n EPSV\r\n211 end");
        break;
      case "PWD":
        send(`257 "${ctx.cwd()}" is the current directory`);
        break;
      case "CWD": {
        const target = resolvePath(arg);
        if (this.dirs.has(target)) {
          ctx.setCwd(target);
          send("250 changed");
        } else {
          send("550 no such directory");
        }
        break;
      }
      case "MKD": {
        const target = resolvePath(arg);
        this.dirs.add(target);
        send(`257 "${target}" created`);
        break;
      }
      case "EPSV": {
        const port = await ctx.openPassive();
        send(`229 Entering Extended Passive Mode (|||${port}|)`);
        break;
      }
      case "SIZE": {
        const data = this.files.get(resolvePath(arg));
        if (data === undefined) {
          send("550 not found");
        } else {
          send(`213 ${data.length}`);
        }
        break;
      }
      case "STOR": {
        if (this.rejectStore) {
          send("553 not allowed");
          break;
        }
        const socket = await ctx.data();
        send("150 opening data connection");
        const chunks: Buffer[] = [];
        socket?.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket?.on("close", () => {
          this.files.set(resolvePath(arg), Buffer.concat(chunks));
          send("226 stored");
        });
        break;
      }
      case "RETR": {
        const data = this.files.get(resolvePath(arg));
        if (this.rejectRead) {
          send("550 no read access");
          break;
        }
        if (data === undefined) {
          send("550 not found");
          break;
        }
        const socket = await ctx.data();
        send("150 opening data connection");
        socket?.end(data, () => send("226 sent"));
        break;
      }
      case "DELE": {
        const target = resolvePath(arg);
        if (this.files.delete(target)) {
          send("250 deleted");
        } else {
          send("550 not found");
        }
        break;
      }
      case "RNFR":
        ctx.setRenameFrom(resolvePath(arg));
        send("350 ready");
        break;
      case "RNTO": {
        const from = ctx.renameFrom();
        const data = from === undefined ? undefined : this.files.get(from);
        if (from === undefined || data === undefined) {
          send("550 no source");
        } else {
          this.files.delete(from);
          this.files.set(resolvePath(arg), data);
          send("250 renamed");
        }
        break;
      }
      case "MLSD": {
        const folder = resolvePath(arg || ctx.cwd());
        const socket = await ctx.data();
        send("150 listing");
        const entries = [
          ...[...this.files.keys()]
            .filter((name) => posix.dirname(name) === folder)
            .map((name) => `size=${this.files.get(name)?.length};type=file; ${posix.basename(name)}\r\n`),
          ...[...this.dirs]
            .filter((name) => name !== folder && posix.dirname(name) === folder)
            .map((name) => `type=dir; ${posix.basename(name)}\r\n`),
        ];
        socket?.end(entries.join(""), () => send("226 done"));
        break;
      }
      case "QUIT":
        send("221 bye");
        ctx.control.end();
        break;
      default:
        send(`502 ${command} not implemented`);
    }
  }
}

describe("the FTP backend, against a real protocol exchange", () => {
  let server: FtpStub;
  const backend = (overrides: Partial<ConstructorParameters<typeof FtpBackend>[0]> = {}) =>
    new FtpBackend({
      host: "127.0.0.1",
      port: server.port,
      username: "u",
      password: "right-password",
      rootPath: "/root",
      tls: false,
      ...overrides,
    });

  beforeEach(async () => {
    server = new FtpStub("right-password");
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("checks, stores through a temporary name, reads back, lists and removes", async () => {
    const ftp = backend();
    await ftp.check();
    const local = join(temp, "input.bin");
    writeFileSync(local, "ftp payload");
    await ftp.upload(local, "a/b/file.bin");

    expect(server.files.has("/root/a/b/file.bin")).toBe(true);
    expect([...server.files.keys()].some((name) => name.endsWith(".partial"))).toBe(false);

    const stat = await ftp.stat("a/b/file.bin");
    expect(stat?.size).toBe(11);
    expect(await ftp.stat("a/b/nothing.bin")).toBeNull();

    const out = join(temp, "out.bin");
    await ftp.download("a/b/file.bin", out);
    expect(readFileSync(out, "utf8")).toBe("ftp payload");

    const names: string[] = [];
    for await (const item of ftp.list("a")) {
      names.push(item.path);
    }
    expect(names).toEqual(["a/b/file.bin"]);

    await ftp.remove("a/b/file.bin");
    await ftp.remove("a/b/file.bin");
    expect(server.files.size).toBe(0);
  });

  it("reports a wrong password and an unreachable server as such", async () => {
    await expect(backend({ password: "wrong" }).check()).rejects.toMatchObject({ kind: "denied" });
    await expect(backend({ port: 1 }).check()).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("reads its probe back when checked, leaving nothing, and fails if it can't (REQ-236)", async () => {
    const ftp = backend();
    await ftp.check();
    expect(server.files.size).toBe(0);

    server.rejectRead = true;
    await expect(ftp.check()).rejects.toBeInstanceOf(StorageError);
    expect(server.files.size).toBe(0);
  });

  it("reports a refused upload without leaving anything", async () => {
    const ftp = backend();
    const local = join(temp, "input.bin");
    writeFileSync(local, "ftp payload");
    server.rejectStore = true;
    await expect(ftp.upload(local, "a/file.bin")).rejects.toBeInstanceOf(StorageError);
    expect(server.files.size).toBe(0);
  });

  it("refuses a path that tries to climb out", async () => {
    await expect(backend().stat("../secret")).rejects.toThrow(/not usable/);
  });
});

/** A complete SSH server with an in-memory SFTP subsystem, using the real protocol. */
class SftpStub {
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>(["/", "/upload"]);
  readonly hostKey = utils.generateKeyPairSync("ed25519");
  rejectRead = false;
  server!: SshServer;
  port = 0;
  fingerprint = "";

  constructor(private readonly password: string) {}

  async start(): Promise<void> {
    this.server = new SshServer({ hostKeys: [this.hostKey.private] }, (client) => {
      client.on("authentication", (ctx) => {
        if (ctx.method === "password" && ctx.password === this.password) {
          ctx.accept();
        } else {
          ctx.reject();
        }
      });
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("sftp", (acceptSftp) => this.serve(acceptSftp()));
        });
      });
      client.on("error", () => {});
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as { port: number }).port;
    const parsed = utils.parseKey(this.hostKey.public);
    this.fingerprint = fingerprintOf((parsed as { getPublicSSH(): Buffer }).getPublicSSH());
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private serve(sftp: SFTPWrapper): void {
    const { STATUS_CODE, OPEN_MODE } = utils.sftp;
    const handles = new Map<number, { path: string; buffer: Buffer; writing: boolean; offset: number }>();
    let nextHandle = 1;
    const handleBuffer = (id: number) => {
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32BE(id, 0);
      return buffer;
    };
    const handleId = (buffer: Buffer) => buffer.readUInt32BE(0);
    const attrs = (size: number, mode: number) => ({
      mode,
      uid: 0,
      gid: 0,
      size,
      atime: 0,
      mtime: 1_700_000_000,
    });
    const fileAttrs = (size: number) => attrs(size, 0o100644);
    const dirAttrs = () => attrs(0, 0o040755);

    sftp
      .on("OPEN", (reqid, filename, flags) => {
        const writing = (flags & OPEN_MODE.WRITE) !== 0;
        if (!writing && !this.files.has(filename)) {
          sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          return;
        }
        const id = nextHandle++;
        const existing = this.files.get(filename);
        handles.set(id, {
          path: filename,
          buffer: writing ? Buffer.alloc(0) : (existing as Buffer),
          writing,
          offset: 0,
        });
        sftp.handle(reqid, handleBuffer(id));
      })
      .on("WRITE", (reqid, handle, offset, data) => {
        const entry = handles.get(handleId(handle));
        if (entry === undefined) {
          sftp.status(reqid, STATUS_CODE.FAILURE);
          return;
        }
        const needed = Number(offset) + data.length;
        if (entry.buffer.length < needed) {
          const grown = Buffer.alloc(needed);
          entry.buffer.copy(grown);
          entry.buffer = grown;
        }
        data.copy(entry.buffer, Number(offset));
        sftp.status(reqid, STATUS_CODE.OK);
      })
      .on("READ", (reqid, handle, offset, length) => {
        const entry = handles.get(handleId(handle));
        if (this.rejectRead) {
          sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          return;
        }
        if (entry === undefined || Number(offset) >= entry.buffer.length) {
          sftp.status(reqid, STATUS_CODE.EOF);
          return;
        }
        sftp.data(reqid, entry.buffer.subarray(Number(offset), Number(offset) + length));
      })
      .on("FSTAT", (reqid, handle) => {
        const entry = handles.get(handleId(handle));
        sftp.attrs(reqid, fileAttrs(entry?.buffer.length ?? 0));
      })
      .on("CLOSE", (reqid, handle) => {
        const entry = handles.get(handleId(handle));
        if (entry?.writing) {
          this.files.set(entry.path, entry.buffer);
        }
        handles.delete(handleId(handle));
        sftp.status(reqid, STATUS_CODE.OK);
      })
      .on("LSTAT", (reqid, path) => this.stat(sftp, reqid, path, fileAttrs, dirAttrs))
      .on("STAT", (reqid, path) => this.stat(sftp, reqid, path, fileAttrs, dirAttrs))
      .on("MKDIR", (reqid, path) => {
        if (this.dirs.has(path)) {
          sftp.status(reqid, STATUS_CODE.FAILURE);
        } else {
          this.dirs.add(path);
          sftp.status(reqid, STATUS_CODE.OK);
        }
      })
      .on("REMOVE", (reqid, path) => {
        if (this.files.delete(path)) {
          sftp.status(reqid, STATUS_CODE.OK);
        } else {
          sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
        }
      })
      .on("RENAME", (reqid, from, to) => {
        const data = this.files.get(from);
        if (data === undefined) {
          sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          return;
        }
        this.files.delete(from);
        this.files.set(to, data);
        sftp.status(reqid, STATUS_CODE.OK);
      })
      .on("OPENDIR", (reqid, path) => {
        const id = nextHandle++;
        handles.set(id, { path, buffer: Buffer.alloc(0), writing: false, offset: 0 });
        sftp.handle(reqid, handleBuffer(id));
      })
      .on("READDIR", (reqid, handle) => {
        const entry = handles.get(handleId(handle));
        if (entry === undefined || entry.offset > 0) {
          sftp.status(reqid, STATUS_CODE.EOF);
          return;
        }
        entry.offset = 1;
        const names = [
          ...[...this.dirs]
            .filter((name) => name !== "/" && posix.dirname(name) === entry.path)
            .map((name) => ({
              filename: posix.basename(name),
              longname: posix.basename(name),
              attrs: dirAttrs(),
            })),
          ...[...this.files.keys()]
            .filter((name) => posix.dirname(name) === entry.path)
            .map((name) => ({
              filename: posix.basename(name),
              longname: posix.basename(name),
              attrs: fileAttrs(this.files.get(name)?.length ?? 0),
            })),
        ];
        sftp.name(reqid, names);
      });
  }

  private stat(
    sftp: SFTPWrapper,
    reqid: number,
    path: string,
    fileAttrs: (size: number) => ReturnType<typeof dummyAttrs>,
    dirAttrs: () => ReturnType<typeof dummyAttrs>,
  ): void {
    if (this.dirs.has(path)) {
      sftp.attrs(reqid, dirAttrs());
    } else if (this.files.has(path)) {
      sftp.attrs(reqid, fileAttrs(this.files.get(path)?.length ?? 0));
    } else {
      sftp.status(reqid, utils.sftp.STATUS_CODE.NO_SUCH_FILE);
    }
  }
}

const dummyAttrs = () => ({ mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 });

describe("the SFTP backend, against a real SSH server", () => {
  let server: SftpStub;
  let known: string | null = null;
  const backend = (overrides: Partial<ConstructorParameters<typeof SftpBackend>[0]> = {}) =>
    new SftpBackend({
      host: "127.0.0.1",
      port: server.port,
      username: "u",
      password: "right-password",
      rootPath: "/upload",
      hostKey: known,
      onHostKey: (fingerprint) => {
        known = fingerprint;
      },
      ...overrides,
    });

  beforeEach(async () => {
    server = new SftpStub("right-password");
    await server.start();
    known = null;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("checks, remembers the server's key, stores through a temporary name, reads, lists and removes", async () => {
    const sftp = backend();
    await sftp.check();
    expect(known).toBe(server.fingerprint);

    const pinned = backend();
    const local = join(temp, "input.bin");
    const payload = randomBytes(200 * 1024);
    writeFileSync(local, payload);
    await pinned.upload(local, "a/file.bin");
    expect([...server.files.keys()]).toEqual(["/upload/a/file.bin"]);

    expect((await pinned.stat("a/file.bin"))?.size).toBe(payload.length);
    expect(await pinned.stat("a/none.bin")).toBeNull();

    const out = join(temp, "out.bin");
    await pinned.download("a/file.bin", out);
    expect(createHash("sha256").update(readFileSync(out)).digest("hex")).toBe(
      createHash("sha256").update(payload).digest("hex"),
    );

    const names: string[] = [];
    for await (const item of pinned.list("a")) {
      names.push(item.path);
    }
    expect(names).toEqual(["a/file.bin"]);

    await pinned.remove("a/file.bin");
    await pinned.remove("a/file.bin");
    expect(server.files.size).toBe(0);
  });

  it("reads its probe back when checked, leaving nothing, and fails if it can't (REQ-236)", async () => {
    const sftp = backend();
    await sftp.check();
    expect(server.files.size).toBe(0);

    server.rejectRead = true;
    await expect(backend().check()).rejects.toBeInstanceOf(StorageError);
    expect(server.files.size).toBe(0);
  });

  it("refuses a server whose key has changed", async () => {
    known = "SHA256:not-the-key-this-server-has";
    await expect(backend({ hostKey: known, onHostKey: undefined }).check()).rejects.toMatchObject({
      kind: "host_key",
    });
  });

  it("reports a wrong password", async () => {
    await expect(backend({ password: "wrong" }).check()).rejects.toMatchObject({ kind: "denied" });
  });

  it("reports an unreachable server", async () => {
    await expect(backend({ port: 1 }).check()).rejects.toMatchObject({ kind: "unreachable" });
  });
});
