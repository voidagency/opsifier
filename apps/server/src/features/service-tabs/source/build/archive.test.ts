import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realTools } from "../../../../core/tools";
import {
  inspectArchive,
  isUnsafeEntryName,
  UnsafeArchiveError,
  unpackArchive,
  unwrapSingleFolder,
  verifyTree,
} from "./archive";

const hasBsdtar = spawnSync("bsdtar", ["--version"]).error === undefined;
const deps = { tools: realTools };

interface TarEntry {
  name: string;
  content?: string;
  /** 0 file, 2 symlink, 5 directory, 6 FIFO. */
  type?: "0" | "1" | "2" | "5" | "6";
  link?: string;
  mode?: number;
}

const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;

/** Written by hand, so a test can say exactly what an honest tool would refuse to produce. */
function tarArchive(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const { name, content = "", type = "0", link = "", mode = 0o644 } of entries) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write(octal(mode, 8), 100, 8, "ascii");
    header.write(octal(0, 8), 108, 8, "ascii");
    header.write(octal(0, 8), 116, 8, "ascii");
    header.write(octal(body.length, 12), 124, 12, "ascii");
    header.write(octal(0, 12), 136, 12, "ascii");
    header.fill(" ", 148, 156);
    header.write(type, 156, 1, "ascii");
    header.write(link, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, body);
    if (body.length % 512 !== 0) {
      blocks.push(Buffer.alloc(512 - (body.length % 512)));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** One stored entry at a time. A `..` in a name is exactly what zip-slip is. */
function zipArchive(entries: ReadonlyArray<{ name: string; content?: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, content = "" } of entries) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let root: string;

const writeArchive = (name: string, data: Buffer) => {
  const path = join(root, name);
  writeFileSync(path, data);
  return path;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opsifier-archive-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("isUnsafeEntryName", () => {
  it.each([
    "../evil",
    "a/../../evil",
    "/etc/passwd",
    "..\\..\\evil",
    "a\\..\\..\\b",
    "C:\\windows\\system32",
    "..\\evil",
  ])("flags %s", (name) => {
    expect(isUnsafeEntryName(name)).toBe(true);
  });

  it.each(["app/main.ts", "a..b/c", ".env", "dir/", "..hidden"])("allows %s", (name) => {
    expect(isUnsafeEntryName(name)).toBe(false);
  });
});

describe.skipIf(!hasBsdtar)("unpackArchive", () => {
  const destination = () => join(root, "out");

  it("unpacks a tar and keeps the executable bit, folders included", async () => {
    const file = writeArchive(
      "app.tar",
      tarArchive([
        { name: "src/", type: "5", mode: 0o755 },
        { name: "src/index.js", content: "console.log(1)\n" },
        { name: "start.sh", content: "#!/bin/sh\n", mode: 0o755 },
      ]),
    );

    await unpackArchive(deps, file, destination());

    expect(readFileSync(join(destination(), "src/index.js"), "utf8")).toBe("console.log(1)\n");
    expect(statSync(join(destination(), "start.sh")).mode & 0o111).not.toBe(0);
  });

  it("unpacks a gzipped tar", async () => {
    const file = writeArchive("app.tar.gz", gzipSync(tarArchive([{ name: "a.txt", content: "hello\n" }])));

    await unpackArchive(deps, file, destination());

    expect(readFileSync(join(destination(), "a.txt"), "utf8")).toBe("hello\n");
  });

  it("unpacks a zip, including its folder entries", async () => {
    const file = writeArchive(
      "app.zip",
      zipArchive([{ name: "dir/" }, { name: "dir/a.txt", content: "from zip\n" }]),
    );

    await unpackArchive(deps, file, destination());

    expect(readFileSync(join(destination(), "dir/a.txt"), "utf8")).toBe("from zip\n");
  });

  it("refuses a tar entry that climbs out, and writes nothing there", async () => {
    const file = writeArchive("evil.tar", tarArchive([{ name: "../evil.txt", content: "pwned\n" }]));

    await expect(unpackArchive(deps, file, destination())).rejects.toBeInstanceOf(UnsafeArchiveError);
    expect(existsSync(join(root, "evil.txt"))).toBe(false);
  });

  it("refuses a zip-slip entry, and writes nothing there", async () => {
    const file = writeArchive("evil.zip", zipArchive([{ name: "../evil.txt", content: "pwned\n" }]));

    await expect(unpackArchive(deps, file, destination())).rejects.toBeInstanceOf(UnsafeArchiveError);
    expect(existsSync(join(root, "evil.txt"))).toBe(false);
  });

  it("refuses an absolute path", async () => {
    const target = join(root, "absolute.txt");
    const file = writeArchive("evil.tar", tarArchive([{ name: target, content: "pwned\n" }]));

    await expect(unpackArchive(deps, file, destination())).rejects.toBeInstanceOf(UnsafeArchiveError);
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a symlink that points outside, even with no entry reaching through it", async () => {
    const file = writeArchive("evil.tar", tarArchive([{ name: "escape", type: "2", link: "/etc" }]));

    await expect(unpackArchive(deps, file, destination())).rejects.toThrow(/link pointing outside/);
  });

  it("refuses a file written through a symlink it just made", async () => {
    mkdirSync(join(root, "victim"));
    const file = writeArchive(
      "evil.tar",
      tarArchive([
        { name: "link", type: "2", link: join(root, "victim") },
        { name: "link/pwned.txt", content: "pwned\n" },
      ]),
    );

    await expect(unpackArchive(deps, file, destination())).rejects.toBeInstanceOf(UnsafeArchiveError);
    expect(readdirSync(join(root, "victim"))).toEqual([]);
  });

  it("refuses a hard link to a file outside the folder", async () => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "secret\n");
    const file = writeArchive(
      "evil.tar",
      tarArchive([{ name: "stolen.txt", type: "1", link: "../secret.txt" }]),
    );

    await expect(unpackArchive(deps, file, destination())).rejects.toBeInstanceOf(UnsafeArchiveError);
    expect(existsSync(join(destination(), "stolen.txt"))).toBe(false);
  });

  it("refuses a hard link to an absolute path", async () => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "secret\n");
    const file = writeArchive("evil.tar", tarArchive([{ name: "stolen.txt", type: "1", link: secret }]));

    await expect(unpackArchive(deps, file, destination())).rejects.toBeInstanceOf(UnsafeArchiveError);
  });

  it("keeps a symlink that stays inside", async () => {
    const file = writeArchive(
      "app.tar",
      tarArchive([
        { name: "real.txt", content: "real\n" },
        { name: "alias.txt", type: "2", link: "real.txt" },
      ]),
    );

    await unpackArchive(deps, file, destination());

    expect(readFileSync(join(destination(), "alias.txt"), "utf8")).toBe("real\n");
  });

  it("refuses a device or FIFO", async () => {
    const file = writeArchive("evil.tar", tarArchive([{ name: "pipe", type: "6" }]));

    await expect(unpackArchive(deps, file, destination())).rejects.toThrow(/special file/);
  });

  it("refuses something that is not an archive", async () => {
    const file = writeArchive("not.zip", Buffer.from("this is not an archive at all"));

    await expect(unpackArchive(deps, file, destination())).rejects.toBeInstanceOf(UnsafeArchiveError);
  });

  it("refuses an archive that unpacks to more than the limit", async () => {
    const file = writeArchive("big.tar", tarArchive([{ name: "big.bin", content: "x".repeat(5000) }]));

    await expect(unpackArchive(deps, file, destination(), { maxBytes: 1000 })).rejects.toThrow(
      /more than the panel allows/,
    );
  });

  it("refuses an archive that nests folders deeper than the limit, before unpacking anything", async () => {
    const file = writeArchive("deep.tar", tarArchive([{ name: "a/b/c/d/e/f.txt", content: "x" }]));
    const target = destination();

    await expect(unpackArchive(deps, file, target, { maxDepth: 3 })).rejects.toThrow(/nested deeper/);
    expect(existsSync(join(target, "a"))).toBe(false);
  });

  it("accepts an archive exactly as deep as the limit", async () => {
    const file = writeArchive("ok.tar", tarArchive([{ name: "a/b/c/d.txt", content: "x" }]));

    await expect(unpackArchive(deps, file, destination(), { maxDepth: 4 })).resolves.toBeUndefined();
  });

  describe("links reached through other links", () => {
    function folderWith(links: Record<string, string>, files: Record<string, string> = {}): string {
      const folder = destination();
      mkdirSync(folder, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        mkdirSync(join(folder, name, ".."), { recursive: true });
        writeFileSync(join(folder, name), content);
      }
      for (const [name, target] of Object.entries(links)) {
        symlinkSync(target, join(folder, name));
      }
      return folder;
    }

    it("refuses one that leaves the folder through another, though its text stays inside", async () => {
      const folder = folderWith({ d: ".", x: "d/../outside" });

      await expect(verifyTree(folder)).rejects.toThrow(/link pointing outside/);
    });

    it("keeps one that reaches a file inside through another", async () => {
      const folder = folderWith({ d: "sub", x: "d/file.txt" }, { "sub/file.txt": "x" });

      await expect(verifyTree(folder)).resolves.toMatchObject({ bytes: 1 });
    });

    it("keeps one that points at nothing yet, inside", async () => {
      await expect(verifyTree(folderWith({ x: "later.txt" }))).resolves.toMatchObject({ bytes: 0 });
    });

    it("refuses one that climbs after a part that does not exist", async () => {
      await expect(verifyTree(folderWith({ x: "missing/../file.txt" }))).rejects.toThrow(
        /link pointing outside/,
      );
    });

    it("refuses a loop", async () => {
      await expect(verifyTree(folderWith({ a: "b", b: "a" }))).rejects.toThrow(/link pointing outside/);
    });
  });

  it("checks the depth again on what was actually unpacked", async () => {
    const folder = destination();
    mkdirSync(join(folder, "a", "b", "c"), { recursive: true });
    writeFileSync(join(folder, "a", "b", "c", "d.txt"), "x");

    await expect(verifyTree(folder, 3)).rejects.toThrow(/nested deeper/);
    await expect(verifyTree(folder, 4)).resolves.toMatchObject({ bytes: 1 });
  });

  it("stops when the action is cancelled", async () => {
    const file = writeArchive("big.tar", tarArchive([{ name: "a.txt", content: "a" }]));
    const controller = new AbortController();
    controller.abort();

    await expect(
      unpackArchive(deps, file, destination(), { signal: controller.signal }),
    ).rejects.toBeDefined();
  });
});

describe.skipIf(!hasBsdtar)("inspectArchive", () => {
  it("accepts a clean archive and refuses a dirty one by name", async () => {
    const clean = writeArchive("clean.tar", tarArchive([{ name: "a.txt", content: "a" }]));
    await expect(inspectArchive(deps, clean)).resolves.toBeUndefined();

    const dirty = writeArchive("dirty.tar", tarArchive([{ name: "../../a.txt", content: "a" }]));
    await expect(inspectArchive(deps, dirty)).rejects.toThrow(/would escape/);
  });
});

describe("unwrapSingleFolder", () => {
  it("steps into the one folder of an archive that has nothing else", async () => {
    mkdirSync(join(root, "shop-main"));
    writeFileSync(join(root, "shop-main", "Dockerfile"), "FROM scratch\n");

    await expect(unwrapSingleFolder(root)).resolves.toBe(join(root, "shop-main"));
  });

  it("leaves everything else as it is", async () => {
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "b.txt"), "b");

    await expect(unwrapSingleFolder(root)).resolves.toBe(root);
  });
});
