import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasEntry, readPlainFile, readStackBytes, syncCheckout } from "./checkout";

/** A stand-in for what the panel keeps beside every stack: its database, and another project's data. */
let base: string;
let panel: string;
let code: string;
let staged: string;

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** A fresh checkout in the staging folder, as Git would leave it. */
function checkout(files: Record<string, string>): string {
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });
  write(staged, files);
  return staged;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "opsifier-checkout-")));
  panel = join(base, "data");
  code = join(base, "data", "projects", "pa", "stack", "code");
  staged = join(base, "staged");
  write(panel, { "opsifier.db": "PANEL DATABASE", "projects/pb/db/volumes/pgdata/PG_VERSION": "16" });
  mkdirSync(code, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("laying a checkout over a stack's folder", () => {
  it("removes what the last checkout brought without following a folder the stack turned into a link", async () => {
    const first = await syncCheckout(
      checkout({ "a/opsifier.db": "x", "b/PG_VERSION": "x", "compose.yaml": "services: {}\n" }),
      code,
      [],
    );
    // What a running stack could do to its own folder through a relative mount of it.
    rmSync(join(code, "a"), { recursive: true });
    symlinkSync(panel, join(code, "a"));
    rmSync(join(code, "b"), { recursive: true });
    symlinkSync(join(panel, "projects", "pb", "db", "volumes", "pgdata"), join(code, "b"));

    await syncCheckout(checkout({ "compose.yaml": "services: {}\n" }), code, first);

    expect(readFileSync(join(panel, "opsifier.db"), "utf8")).toBe("PANEL DATABASE");
    expect(readFileSync(join(panel, "projects", "pb", "db", "volumes", "pgdata", "PG_VERSION"), "utf8")).toBe(
      "16",
    );
    expect(lstatSync(join(code, "a")).isSymbolicLink()).toBe(true);
  });

  it("removes a link the stack put in place of a file, and leaves what it pointed at", async () => {
    const first = await syncCheckout(checkout({ "notes.txt": "x", "compose.yaml": "" }), code, []);
    rmSync(join(code, "notes.txt"));
    symlinkSync(join(panel, "opsifier.db"), join(code, "notes.txt"));

    await syncCheckout(checkout({ "compose.yaml": "" }), code, first);

    expect(existsSync(join(code, "notes.txt"))).toBe(false);
    expect(lstatSync(join(code, "notes.txt"), { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(join(panel, "opsifier.db"), "utf8")).toBe("PANEL DATABASE");
  });

  it("writes the new checkout over links without following them", async () => {
    mkdirSync(join(code, "deploy"));
    symlinkSync(panel, join(code, "conf"));
    symlinkSync(join(panel, "opsifier.db"), join(code, "deploy", "compose.yaml"));

    await syncCheckout(
      checkout({ "conf/opsifier.db": "from the repository", "deploy/compose.yaml": "services: {}\n" }),
      code,
      [],
    );

    expect(readFileSync(join(panel, "opsifier.db"), "utf8")).toBe("PANEL DATABASE");
    expect(lstatSync(join(code, "conf")).isDirectory()).toBe(true);
    expect(readFileSync(join(code, "conf", "opsifier.db"), "utf8")).toBe("from the repository");
    expect(lstatSync(join(code, "deploy", "compose.yaml")).isFile()).toBe(true);
    expect(readFileSync(join(code, "deploy", "compose.yaml"), "utf8")).toBe("services: {}\n");
  });

  it("keeps what the stack wrote itself, and the links the repository holds as links", async () => {
    write(code, { "data/written-by-stack.txt": "keep me" });
    const tree = checkout({ "compose.yaml": "services: {}\n", "real/app.conf": "x" });
    symlinkSync("real/app.conf", join(tree, "app.conf"));

    const incoming = await syncCheckout(tree, code, []);

    expect(incoming.sort()).toEqual(["app.conf", "compose.yaml", join("real", "app.conf")]);
    expect(readFileSync(join(code, "data", "written-by-stack.txt"), "utf8")).toBe("keep me");
    expect(readlinkSync(join(code, "app.conf"))).toBe("real/app.conf");
  });

  it("stops at a folder of the stack's where the repository has a file", async () => {
    mkdirSync(join(code, "compose.yaml"));
    await expect(syncCheckout(checkout({ "compose.yaml": "x" }), code, [])).rejects.toThrow(
      /a folder where the repository has a file: compose.yaml/,
    );
  });

  it("leaves a manifest's entry that would leave the folder alone", async () => {
    await syncCheckout(checkout({ "compose.yaml": "" }), code, ["../../../../opsifier.db", ""]);
    expect(readFileSync(join(panel, "opsifier.db"), "utf8")).toBe("PANEL DATABASE");
  });
});

describe("reading a file of a stack's folder", () => {
  it("reads a plain file, and nothing reached through a link", async () => {
    write(code, { "deploy/.env.example": "NAME=value\n", "deploy/sub/.env": "x" });
    symlinkSync(join(panel, "opsifier.db"), join(code, "deploy", "linked.env"));
    symlinkSync(join(code, "deploy"), join(code, "through"));

    expect(await readPlainFile(code, join(code, "deploy", ".env.example"), 1024)).toBe("NAME=value\n");
    expect(await readPlainFile(code, join(code, "deploy", "linked.env"), 1024)).toBeNull();
    expect(await readPlainFile(code, join(code, "through", ".env.example"), 1024)).toBeNull();
    expect(await readPlainFile(code, join(panel, "opsifier.db"), 1024)).toBeNull();
    expect(await readPlainFile(code, join(code, "deploy", ".env.example"), 4)).toBeNull();
    expect(await readPlainFile(code, join(code, "deploy", "missing"), 1024)).toBeNull();
  });

  it("reads a file whose folder's name starts with two dots", async () => {
    write(code, { "..vars/app.env": "A=1\n" });
    expect(await readPlainFile(code, join(code, "..vars", "app.env"), 1024)).toBe("A=1\n");
  });

  it("says what it found when there is no plain file to read, without waiting on a pipe", async () => {
    write(code, { "big.yml": "x".repeat(2048), "small.yml": "services: {}\n" });
    execFileSync("mkfifo", [join(code, "pipe")]);
    symlinkSync(join(code, "small.yml"), join(code, "linked.yml"));

    expect(await readStackBytes(code, join(code, "pipe"), 1024)).toBe("not_plain");
    expect(await readStackBytes(code, join(code, "linked.yml"), 1024)).toBe("not_plain");
    expect(await readStackBytes(code, join(code, "big.yml"), 1024)).toBe("too_large");
    expect(await readStackBytes(code, join(code, "absent.yml"), 1024)).toBe("missing");
    expect((await readStackBytes(code, join(code, "small.yml"), 1024)).toString()).toBe("services: {}\n");
  });

  it("sees a link as something that is there", async () => {
    symlinkSync(join(base, "nowhere"), join(code, ".env"));
    expect(await hasEntry(code, join(code, ".env"))).toBe(true);
    expect(await hasEntry(code, join(code, "absent"))).toBe(false);
  });
});
