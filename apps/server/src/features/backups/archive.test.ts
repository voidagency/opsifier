import { chownSync, createWriteStream, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchiveRefused, archiveBlocks, readableBlocks, VolumeExtractor } from "./archive";

let root: string;
let source: string;
let target: string;

beforeEach(async () => {
  ownerCalls.length = 0;
  root = await mkdtemp(join(tmpdir(), "opsifier-archive-"));
  source = join(root, "source");
  target = join(root, "target");
  await mkdir(source);
  await mkdir(target);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function archive(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of archiveBlocks(source)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function extract(tar: Buffer, options: Partial<ConstructorParameters<typeof VolumeExtractor>[0]> = {}) {
  const extractor = new VolumeExtractor({ root: target, maxBytes: null, ignoreOwners: true, ...options });
  await pipeline(Readable.from([tar]), extractor);
  return extractor;
}

/** Builds a tar with exactly the headers a test wants, however wrong they are. */
function header(fields: { name: string; typeflag?: string; size?: number; magic?: string }): Buffer {
  const block = Buffer.alloc(512);
  block.write(fields.name, 0, 100, "utf8");
  block.write("0000644\0", 100, 8, "latin1");
  block.write("0000000\0", 108, 8, "latin1");
  block.write("0000000\0", 116, 8, "latin1");
  block.write(`${(fields.size ?? 0).toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
  block.write("00000000000\0", 136, 12, "latin1");
  block.write(fields.typeflag ?? "0", 156, 1, "latin1");
  block.write(fields.magic ?? "ustar\0", 257, 6, "latin1");
  block.write("00", 263, 2, "latin1");
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return block;
}

const isRoot = process.getuid?.() === 0;

/** Owners can only really change as root: elsewhere, the calls themselves are what a test can see. */
const ownerCalls = vi.hoisted((): Array<[string, number, number]> => []);
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const { chownSync: chownNow } = await import("node:fs");
  return {
    ...actual,
    chown: async (path: string, uid: number, gid: number) => {
      ownerCalls.push([path, uid, gid]);
      if (process.getuid?.() === 0) {
        chownNow(path, uid, gid);
      }
    },
  };
});

/** A pax-style entry: what the writer produces for a name or owner the plain header can't hold. */
function paxRecords(records: Array<[string, string]>): Buffer {
  const body = records
    .map(([key, value]) => {
      const text = ` ${key}=${value}\n`;
      const rest = Buffer.byteLength(text);
      let length = rest + 1;
      while (String(length).length + rest !== length) {
        length = String(length).length + rest;
      }
      return `${length}${text}`;
    })
    .join("");
  const bytes = Buffer.from(body, "utf8");
  return Buffer.concat([
    header({ name: "./PaxHeaders/1", typeflag: "x", size: bytes.length }),
    bytes,
    Buffer.alloc((512 - (bytes.length % 512)) % 512),
  ]);
}

function ownedHeader(
  name: string,
  typeflag: string,
  size: number,
  owner: { uid: number; gid: number; mode: number },
): Buffer {
  const block = header({ name, typeflag, size });
  block.write(`${owner.mode.toString(8).padStart(7, "0")}\0`, 100, 8, "latin1");
  let sum = 0;
  for (let index = 0; index < 512; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return block;
}

function paxFile(name: string, content: string, owner: { uid: number; gid: number; mode: number }): Buffer {
  const data = Buffer.from(content, "utf8");
  return Buffer.concat([
    paxRecords([
      ["path", name],
      ["uid", String(owner.uid)],
      ["gid", String(owner.gid)],
    ]),
    ownedHeader("./non-ascii-name", "0", data.length, owner),
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
    Buffer.alloc(1024),
  ]);
}

function paxDirectory(name: string, owner: { uid: number; gid: number; mode: number }): Buffer {
  return Buffer.concat([
    paxRecords([
      ["path", `${name}/`],
      ["uid", String(owner.uid)],
      ["gid", String(owner.gid)],
    ]),
    ownedHeader("./non-ascii-name", "5", 0, owner),
    Buffer.alloc(1024),
  ]);
}

const END = Buffer.alloc(1024);
const body = (data: string) => {
  const buffer = Buffer.from(data);
  return Buffer.concat([buffer, Buffer.alloc((512 - (buffer.length % 512)) % 512)]);
};

describe("volume archives", () => {
  it("round-trips files, modes, a Unicode name, a nested folder and an empty folder", async () => {
    await mkdir(join(source, "sous dossier", "déjà"), { recursive: true });
    const unicode = join(source, "sous dossier", "déjà", "fichier-été.txt");
    await writeFile(unicode, "contenu été\n");
    const { chmod } = await import("node:fs/promises");
    await chmod(unicode, 0o640);
    await writeFile(join(source, "top.txt"), "original\n", { mode: 0o755 });
    await mkdir(join(source, "empty-dir"), { mode: 0o750 });
    await utimes(join(source, "top.txt"), 1_700_000_000, 1_700_000_000);

    const tar = await archive();
    expect(tar.length % 512).toBe(0);
    await extract(tar);

    expect(readFileSync(join(target, "sous dossier", "déjà", "fichier-été.txt"), "utf8")).toBe(
      "contenu été\n",
    );
    expect(statSync(join(target, "sous dossier", "déjà", "fichier-été.txt")).mode & 0o777).toBe(0o640);
    expect(statSync(join(target, "top.txt")).mode & 0o777).toBe(0o755);
    expect(Math.floor(statSync(join(target, "top.txt")).mtimeMs / 1000)).toBe(1_700_000_000);
    expect(statSync(join(target, "empty-dir")).mode & 0o777).toBe(0o750);
  });

  it.each([
    ["the folder it is reading", ["outer", "sub"]],
    ["a folder above it", ["outer"]],
  ])("follows no link swapped in for %s while it runs", async (_label, swapped) => {
    await mkdir(join(source, "outer", "sub"), { recursive: true });
    // Read first and slowly, which leaves time to swap a folder before the next name is reached.
    await writeFile(join(source, "outer", "sub", "a-big"), Buffer.alloc(3 * 1024 * 1024, 1));
    await writeFile(join(source, "outer", "sub", "marker.txt"), "the stack's own\n");
    // Another project's volume, which holds the same names.
    const other = join(root, "other");
    await mkdir(join(other, "sub"), { recursive: true });
    await writeFile(join(other, "sub", "marker.txt"), "ANOTHER PROJECT'S SECRET\n");

    const chunks: Buffer[] = [];
    let readingBigFile = false;
    let swappedYet = false;
    let refused: unknown = null;
    try {
      for await (const chunk of archiveBlocks(source)) {
        chunks.push(chunk);
        if (chunk.includes(Buffer.from("outer/sub/a-big"))) {
          readingBigFile = true;
        } else if (readingBigFile && !swappedYet) {
          // Halfway through the big file, the stack puts a link where a folder was.
          const path = join(source, ...swapped);
          await rename(path, `${path}-moved`);
          await symlink(swapped.length === 2 ? join(other, "sub") : other, path);
          swappedYet = true;
        }
      }
    } catch (error) {
      refused = error;
    }

    expect(swappedYet).toBe(true);
    expect(Buffer.concat(chunks).includes(Buffer.from("ANOTHER PROJECT'S SECRET"))).toBe(false);
    if (refused !== null) {
      expect(refused).toBeInstanceOf(ArchiveRefused);
    }
  });

  it("makes a valid empty archive of an empty volume", async () => {
    const tar = await archive();
    expect(tar.length).toBe(1024);
    const extractor = await extract(tar);
    expect(extractor.entries).toBe(0);
    expect(await readdir(target)).toEqual([]);
  });

  it("stores a long name through an extended header and reads it back", async () => {
    const long = `${"a".repeat(120)}.txt`;
    await writeFile(join(source, long), "x");
    await extract(await archive());
    expect(readFileSync(join(target, long), "utf8")).toBe("x");
  });

  it("works through gzip as a stored archive would", async () => {
    await writeFile(join(source, "a.txt"), "hello");
    const file = join(root, "archive.tar.gz");
    await pipeline(readableBlocks(archiveBlocks(source)), createGzip(), createWriteStream(file));
    const tar = gunzipSync(readFileSync(file));
    await extract(tar);
    expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("hello");
  });

  it.each([
    ["a relative link inside the volume", "top.txt"],
    ["a link to an absolute path", "/etc/passwd"],
    ["a link climbing out of the volume", "../../secret"],
  ])("refuses to pack %s, naming it", async (_label, destination) => {
    await writeFile(join(source, "top.txt"), "x");
    await symlink(destination, join(source, "the-link"));
    await expect(archive()).rejects.toThrow(/the-link is a symbolic link/);
  });

  it("packs a hard link as a plain copy of its file", async () => {
    const { link } = await import("node:fs/promises");
    await writeFile(join(source, "original.txt"), "shared\n");
    await link(join(source, "original.txt"), join(source, "copy.txt"));

    const tar = await archive();
    await extract(tar);

    expect(readFileSync(join(target, "copy.txt"), "utf8")).toBe("shared\n");
    expect(statSync(join(target, "copy.txt")).nlink).toBe(1);
  });
});

describe("owners and modes (REQ-696)", () => {
  const name = "dossier-été/données-日本語.txt";

  it("gives a restored file its recorded owner, group and mode, with its Unicode name intact", async () => {
    const contents = "contenu été 日本語\n";
    const entry = paxFile(name, contents, { uid: 1234567, gid: 2345678, mode: 0o640 });

    await extract(entry, { ignoreOwners: false });

    expect(readFileSync(join(target, name), "utf8")).toBe(contents);
    expect(statSync(join(target, name)).mode & 0o777).toBe(0o640);
    expect(ownerCalls).toEqual([[join(target, name), 1234567, 2345678]]);
  });

  it("gives a restored folder its owner too", async () => {
    const entry = paxDirectory("dossier-été", { uid: 1001, gid: 1002, mode: 0o750 });

    await extract(entry, { ignoreOwners: false });

    expect(statSync(join(target, "dossier-été")).mode & 0o777).toBe(0o750);
    expect(ownerCalls).toEqual([[join(target, "dossier-été"), 1001, 1002]]);
  });

  it("does not touch owners when told not to, as on a panel that is not root", async () => {
    await extract(paxFile("plain.txt", "x", { uid: 1, gid: 2, mode: 0o644 }));
    expect(ownerCalls).toEqual([]);
  });

  it.runIf(isRoot)("really restores them, as the panel does in production", async () => {
    const original = join(source, "dossier-été", "données-日本語.txt");
    await mkdir(join(source, "dossier-été"));
    await writeFile(original, "contenu été 日本語\n", { mode: 0o640 });
    chownSync(original, 1234, 2345);
    chownSync(join(source, "dossier-été"), 3456, 4567);

    await extract(await archive(), { ignoreOwners: false });

    const restored = statSync(join(target, "dossier-été", "données-日本語.txt"));
    expect(readFileSync(join(target, "dossier-été", "données-日本語.txt"), "utf8")).toBe(
      "contenu été 日本語\n",
    );
    expect([restored.uid, restored.gid, restored.mode & 0o777]).toEqual([1234, 2345, 0o640]);
    const folder = statSync(join(target, "dossier-été"));
    expect([folder.uid, folder.gid]).toEqual([3456, 4567]);
  });
});

describe("the archive reader refuses", () => {
  const cases: Array<[string, Buffer, RegExp]> = [
    ["a path that climbs out", Buffer.concat([header({ name: "../evil" }), END]), /leave its folder/],
    ["an absolute path", Buffer.concat([header({ name: "/etc/passwd" }), END]), /unusable path/],
    ["a device", Buffer.concat([header({ name: "dev", typeflag: "3" }), END]), /can't be restored safely/],
    [
      "a named pipe",
      Buffer.concat([header({ name: "fifo", typeflag: "6" }), END]),
      /can't be restored safely/,
    ],
    [
      "a GNU long name extension",
      Buffer.concat([header({ name: "x", typeflag: "L" }), END]),
      /can't be restored safely/,
    ],
    [
      "a corrupted header",
      (() => {
        const tar = Buffer.concat([header({ name: "ok.txt" }), END]);
        tar[0] = 0x41;
        return tar;
      })(),
      /checksum/,
    ],
    ["a foreign tar format", Buffer.concat([header({ name: "x", magic: "ustar  " }), END]), /format/],
    ["a truncated archive", header({ name: "cut.txt", size: 2048 }), /incomplete/],
    [
      "data after the end",
      Buffer.concat([header({ name: "a.txt", size: 0 }), END, header({ name: "b.txt" })]),
      /after its end/,
    ],
    [
      "a name given twice",
      Buffer.concat([header({ name: "twice.txt" }), header({ name: "twice.txt" }), END]),
      /twice/,
    ],
  ];

  it.each(cases)("%s", async (_name, tar, message) => {
    const failure = await extract(tar).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ArchiveRefused);
    expect(String((failure as Error).message)).toMatch(message);
  });

  const linkHeader = (name: string, target: string): Buffer => {
    const link = Buffer.from(header({ name, typeflag: "2" }));
    link.write(target, 157, 100, "utf8");
    let sum = 0;
    for (let index = 0; index < 512; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : (link[index] ?? 0);
    }
    link.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
    return link;
  };

  it("a symbolic link staying inside the folder (REQ-394)", async () => {
    await expect(extract(Buffer.concat([linkHeader("in", "elsewhere.txt"), END]))).rejects.toThrow(
      /contains a link/,
    );
  });

  it("a symbolic link leaving the folder", async () => {
    await expect(extract(Buffer.concat([linkHeader("out", "../../etc/passwd"), END]))).rejects.toThrow(
      /contains a link/,
    );
  });

  it("a hard link", async () => {
    await expect(extract(Buffer.concat([header({ name: "hard", typeflag: "1" }), END]))).rejects.toThrow(
      /contains a link/,
    );
  });

  it("more data than the manifest allows", async () => {
    await expect(
      extract(Buffer.concat([header({ name: "big", size: 1024 }), body("x".repeat(1024)), END]), {
        maxBytes: 100,
      }),
    ).rejects.toThrow(/more data than its manifest/);
  });
});
