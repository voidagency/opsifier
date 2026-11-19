import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { excludedFolders, ignoreInputs, readContexts, writableInContext } from "./contexts";
import { heldByRunning } from "./own-folder";

describe("what an ignore file leaves out for sure", () => {
  it("takes plain names, however they are written", () => {
    expect(excludedFolders("data\n/logs/\n  uploads  \n# a comment\n\nsub/inner\n")).toEqual([
      "data",
      "logs",
      "uploads",
      "sub/inner",
    ]);
  });

  it("takes no pattern, nor anything above the context", () => {
    expect(excludedFolders("dat*\n**/data\n[ab]\n../data\n.\ndata\n")).toEqual(["data"]);
  });

  it.each([
    ["an exception BuildKit reads after a U+0085 Go trims", "data\n\u0085!data\n"],
    ["a name BuildKit keeps a U+FEFF in, past the first line", "# runtime\n\uFEFFdata\n"],
    ["any other character outside plain ASCII", "data\nd\u00e1ta\n"],
  ])("takes nothing from a file with %s", (_label, text) => {
    expect(excludedFolders(text)).toEqual([]);
  });

  it("takes nothing from a file with an exception, which could bring part of a folder back", () => {
    expect(excludedFolders("data\nlogs\n!logs/keep\n")).toEqual([]);
  });
});

describe("the contexts a stack's builds walk", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "opsifier-contexts-")));
    mkdirSync(join(root, "app"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const inputs = (dockerfile = join(root, "app", "Dockerfile")) => [
    { service: "web", path: join(root, "app"), field: "context", written: false },
    { service: "web", path: dockerfile, field: "dockerfile", written: false },
    { service: "web", path: join(root, "assets"), field: "additional_contexts", written: false },
  ];
  const bind = (path: string, writable = true) => ({ service: "worker", path: join(root, path), writable });

  it("reads the ignore file beside the Dockerfile first, then the context's own", async () => {
    writeFileSync(join(root, "app", ".dockerignore"), "uploads\n");
    let contexts = await readContexts(root, inputs());
    expect(contexts.map((context) => [context.field, context.excluded])).toEqual([
      ["context", ["uploads"]],
      ["additional_contexts", []],
    ]);
    expect(ignoreInputs(contexts).map((input) => input.path)).toEqual([join(root, "app", ".dockerignore")]);

    writeFileSync(join(root, "app", "Dockerfile.dockerignore"), "cache\n");
    contexts = await readContexts(root, inputs());
    expect(contexts[0]?.excluded).toEqual(["cache"]);
    expect(contexts[0]?.ignoreFile).toBe(join(root, "app", "Dockerfile.dockerignore"));
  });

  it("finds a folder a child writes inside a context, unless it is left out or read-only", async () => {
    writeFileSync(join(root, "app", ".dockerignore"), "uploads\n");
    const contexts = await readContexts(root, inputs());

    expect(writableInContext(contexts, [bind("app/uploads"), bind("app/uploads/deeper")])).toBeNull();
    expect(writableInContext(contexts, [bind("app/static", false)])).toBeNull();
    expect(writableInContext(contexts, [bind("app/static")])).toMatchObject({ path: "static" });
    expect(writableInContext(contexts, [bind("assets/x")])).toMatchObject({
      path: "x",
      context: { field: "additional_contexts" },
    });
  });

  it("refuses an ignore file that is not a plain file of the stack", async () => {
    symlinkSync(join(root, "elsewhere"), join(root, "app", ".dockerignore"));
    await expect(readContexts(root, inputs())).rejects.toThrow(/is not a plain file of at most 1 MiB/);
  });
});

describe("a running container's bind inside what a new build walks", () => {
  const ROOT = "/var/lib/opsifier/projects/shop/stack/code";
  const guarded = (excluded: string[]) => ({
    mounts: [],
    files: [`${ROOT}/docker-compose.yml`],
    inputs: [`${ROOT}/app`],
    contexts: [{ path: `${ROOT}/app`, excluded }],
  });
  const bind = (source: string, rw: boolean) => ({ child: "w", container: "shop_stack-w-1", source, rw });

  it("is refused when it can write there and nothing leaves it out", () => {
    expect(heldByRunning(ROOT, [bind(`${ROOT}/app/uploads`, true)], guarded([]))).toMatchObject({
      path: "app/uploads",
      holds: "app",
      fromContext: "uploads",
    });
  });

  it("is let through when read-only, or in a folder the context's ignore file leaves out", () => {
    expect(heldByRunning(ROOT, [bind(`${ROOT}/app/uploads`, false)], guarded([]))).toBeNull();
    expect(heldByRunning(ROOT, [bind(`${ROOT}/app/uploads/x`, true)], guarded(["uploads"]))).toBeNull();
  });
});
