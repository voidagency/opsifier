import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDirectory, assertFile, resolveInside, SourcePathError } from "./paths";

let root: string;
let code: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opsifier-paths-"));
  code = join(root, "code");
  mkdirSync(join(code, "apps", "web"), { recursive: true });
  writeFileSync(join(code, "Dockerfile"), "FROM scratch\n");
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside", "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(root, "secret.txt"), "secret\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveInside", () => {
  it("resolves paths that stay inside", async () => {
    await expect(resolveInside(code, "", "The build path")).resolves.toMatch(/code$/);
    await expect(resolveInside(code, "apps/web", "The build path")).resolves.toMatch(/apps\/web$/);
    await expect(resolveInside(code, "Dockerfile", "The Dockerfile")).resolves.toMatch(/Dockerfile$/);
  });

  it("follows a symlink that stays inside", async () => {
    symlinkSync("apps/web", join(code, "current"));
    await expect(resolveInside(code, "current", "The build path")).resolves.toMatch(/apps\/web$/);
  });

  it("refuses a symlink to a folder outside the checkout", async () => {
    symlinkSync(join(root, "outside"), join(code, "escape"));
    await expect(resolveInside(code, "escape", "The build path")).rejects.toBeInstanceOf(SourcePathError);
    await expect(resolveInside(code, "escape/Dockerfile", "The Dockerfile")).rejects.toThrow(
      /leaves the source/,
    );
  });

  it("refuses a symlinked file outside the checkout", async () => {
    symlinkSync(join(root, "secret.txt"), join(code, "Dockerfile.link"));
    await expect(resolveInside(code, "Dockerfile.link", "The Dockerfile")).rejects.toThrow(
      /leaves the source/,
    );
  });

  it("refuses a relative symlink that climbs out", async () => {
    symlinkSync("../../outside", join(code, "apps", "up"));
    await expect(resolveInside(code, "apps/up", "The build path")).rejects.toThrow(/leaves the source/);
  });

  it("refuses a chain of symlinks that ends outside", async () => {
    symlinkSync(join(root, "outside"), join(code, "first"));
    symlinkSync("first", join(code, "second"));
    await expect(resolveInside(code, "second", "The build path")).rejects.toThrow(/leaves the source/);
  });

  it("reports a path that does not exist", async () => {
    await expect(resolveInside(code, "missing", "The build path")).rejects.toThrow(/does not exist/);
  });

  it("tells files from folders", async () => {
    await expect(assertDirectory(join(code, "Dockerfile"), "The build path", "/Dockerfile")).rejects.toThrow(
      /not a directory/,
    );
    await expect(assertFile(join(code, "apps"), "The Dockerfile", "apps")).rejects.toThrow(/not a file/);
  });
});
