import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { BASE_FILE, ProxyFiles, type RewritePlan } from "./index";

const failure = vi.hoisted(() => ({
  /** Throws to make a rename fail, so a failure can be placed exactly. */
  onRename: null as ((to: string) => void) | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      failure.onRename?.(to);
      return actual.rename(from, to);
    },
  };
});

let directory: string;
let dynamicDir: string;
let files: ProxyFiles;

const original = { base: stringify({ http: { routers: { base: "old" } } }), a: "a: old\n", b: "b: old\n" };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "opsifier-rewrite-"));
  dynamicDir = join(directory, "dynamic");
  mkdirSync(dynamicDir);
  writeFileSync(join(dynamicDir, BASE_FILE), original.base);
  writeFileSync(join(dynamicDir, "shop__a.yaml"), original.a);
  writeFileSync(join(dynamicDir, "shop__b.yaml"), original.b);
  files = new ProxyFiles(dynamicDir, { apply: (_file, config) => ({ guarded: config }) });
  failure.onRename = null;
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const readAll = () => ({
  base: readFileSync(join(dynamicDir, BASE_FILE), "utf8"),
  a: readFileSync(join(dynamicDir, "shop__a.yaml"), "utf8"),
  b: readFileSync(join(dynamicDir, "shop__b.yaml"), "utf8"),
});

const temporaries = () => readdirSync(dynamicDir).filter((name) => name.endsWith(".tmp"));

function plan(overrides: Partial<RewritePlan> = {}): RewritePlan & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    protecting: false,
    render: (file, config) => ({ file, was: config }),
    commit: () => log.push("commit"),
    revert: () => log.push("revert"),
    ...overrides,
  };
}

describe("changing every routing file together", () => {
  it("rewrites all of them, leaving no temporary file behind", async () => {
    const change = plan();

    await files.rewriteAll(() => change);

    expect(parse(readAll().a)).toMatchObject({ file: "shop__a.yaml" });
    expect(parse(readAll().b)).toMatchObject({ file: "shop__b.yaml" });
    expect(parse(readAll().base)).toMatchObject({ file: BASE_FILE });
    expect(temporaries()).toEqual([]);
    expect(change.log).toEqual(["commit"]);
  });

  it("leaves a file alone when it would not change", async () => {
    const change = plan({
      render: (file, config) => (file === "shop__a.yaml" ? (config as object) : { changed: true }),
    });
    const renames: string[] = [];
    failure.onRename = (to) => renames.push(to);

    await files.rewriteAll(() => change);

    expect(renames.every((to) => !to.endsWith("shop__a.yaml"))).toBe(true);
    expect(readAll().a).toBe(original.a);
  });

  it("changes nothing at all when one file can't be rendered", async () => {
    const change = plan({
      render: (file) => {
        if (file === "shop__b.yaml") {
          throw new Error("no");
        }
        return {};
      },
    });

    await expect(files.rewriteAll(() => change)).rejects.toThrow("no");

    expect(readAll()).toEqual(original);
    expect(temporaries()).toEqual([]);
    expect(change.log).toEqual([]);
  });

  it("restores every file, and the state, when a rename fails partway", async () => {
    const change = plan();
    let renamed = 0;
    failure.onRename = () => {
      renamed += 1;
      if (renamed === 2) {
        throw new Error("rename failed");
      }
    };

    await expect(files.rewriteAll(() => change)).rejects.toThrow("rename failed");

    expect(readAll()).toEqual(original);
    expect(temporaries()).toEqual([]);
    expect(change.log).toEqual(["revert"]);
  });

  it("swaps the base file last and the state last when protection is coming off", async () => {
    const order: string[] = [];
    failure.onRename = (to) => order.push(to.slice(dynamicDir.length + 1));
    const change = plan({ commit: () => order.push("state") });

    await files.rewriteAll(() => change);

    expect(order).toEqual(["shop__a.yaml", "shop__b.yaml", BASE_FILE, "state"]);
  });

  it("stores the state first and swaps the base file first when protection goes on", async () => {
    const order: string[] = [];
    failure.onRename = (to) => order.push(to.slice(dynamicDir.length + 1));
    const change = plan({ protecting: true, commit: () => order.push("state") });

    await files.rewriteAll(() => change);

    expect(order).toEqual(["state", BASE_FILE, "shop__a.yaml", "shop__b.yaml"]);
  });

  it("takes the state back and restores the files when going protected fails partway", async () => {
    const change = plan({ protecting: true });
    failure.onRename = (to) => {
      if (to.endsWith("shop__b.yaml")) {
        throw new Error("rename failed");
      }
    };

    await expect(files.rewriteAll(() => change)).rejects.toThrow("rename failed");

    expect(readAll()).toEqual(original);
    expect(change.log).toEqual(["commit", "revert"]);
  });

  it("removes a file it can't put back while protection stands, so no route is left open", async () => {
    const change = plan();
    let renamesOfA = 0;
    failure.onRename = (to) => {
      // a is swapped, b's swap then fails, and putting a back fails too.
      renamesOfA += to.endsWith("shop__a.yaml") ? 1 : 0;
      if (!to.endsWith("shop__a.yaml") || renamesOfA > 1) {
        throw new Error("everything is failing now");
      }
    };

    await expect(files.rewriteAll(() => change)).rejects.toThrow("everything is failing now");

    // a was swapped, then could not be restored: it is gone rather than left open.
    expect(existsSync(join(dynamicDir, "shop__a.yaml"))).toBe(false);
    expect(readFileSync(join(dynamicDir, "shop__b.yaml"), "utf8")).toBe(original.b);
    expect(change.log).toEqual(["revert"]);
  });

  it("lets a single write queue behind the whole change, so it can't land under the old state", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const change = plan();
    const whole = files.rewriteAll(async () => {
      await held;
      return change;
    });
    const single = files.writeService("shop", "a", { after: true });
    let singleFinished = false;
    void single.then(() => {
      singleFinished = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(singleFinished).toBe(false);

    release();
    await Promise.all([whole, single]);

    expect(parse(readAll().a)).toEqual({ guarded: { after: true } });
  });

  it("refuses to write a file the guard refuses, leaving the old one in place", async () => {
    const refusing = new ProxyFiles(dynamicDir, {
      apply: () => {
        throw new Error("refused");
      },
    });

    await expect(refusing.writeService("shop", "a", { x: 1 })).rejects.toThrow("refused");
    expect(readAll().a).toBe(original.a);
  });

  it("brings each file in line on its own at startup and lists those it could not", async () => {
    writeFileSync(join(dynamicDir, "shop__bad.yaml"), "not: [valid");

    const failed = await files.reconcile((file, config) => ({ file, was: config }));

    expect(failed).toEqual(["shop__bad.yaml"]);
    expect(parse(readAll().a)).toMatchObject({ file: "shop__a.yaml" });
  });
});

describe("reading the routing files", () => {
  it("reports what is on disk and says when a file can't be read", async () => {
    writeFileSync(join(dynamicDir, "shop__bad.yaml"), "not: [valid");
    writeFileSync(join(dynamicDir, ".shop__a.yaml.abc.tmp"), "half");

    const result = await files.readAll();

    expect(result.map((entry) => entry.file)).toEqual([
      BASE_FILE,
      "shop__a.yaml",
      "shop__b.yaml",
      "shop__bad.yaml",
    ]);
    expect(result.find((entry) => entry.file === "shop__bad.yaml")?.config).toBeNull();
    expect(result.find((entry) => entry.file === "shop__a.yaml")?.config).toEqual({ a: "old" });
  });

  it("returns nothing for a directory that does not exist yet", async () => {
    await expect(
      new ProxyFiles(join(directory, "missing"), { apply: () => ({}) }).readAll(),
    ).resolves.toEqual([]);
  });
});
