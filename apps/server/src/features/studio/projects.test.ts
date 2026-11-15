import { describe, expect, it } from "vitest";
import { previewDockerfile } from "./preview";
import { folderName, parseRepository, previewName, readCloneResult } from "./projects";

describe("a GitHub repository given to the Studio", () => {
  it("is read from its address, its SSH address, or owner/name", () => {
    for (const input of [
      "https://github.com/mehdinajeddine/un-mot-par-jour-landing",
      "https://github.com/mehdinajeddine/un-mot-par-jour-landing.git",
      "https://github.com/mehdinajeddine/un-mot-par-jour-landing/",
      "git@github.com:mehdinajeddine/un-mot-par-jour-landing.git",
      "github.com/mehdinajeddine/un-mot-par-jour-landing",
      "  mehdinajeddine/un-mot-par-jour-landing ",
    ]) {
      expect(parseRepository(input)).toEqual({
        owner: "mehdinajeddine",
        name: "un-mot-par-jour-landing",
        slug: "mehdinajeddine/un-mot-par-jour-landing",
        url: "https://github.com/mehdinajeddine/un-mot-par-jour-landing.git",
      });
    }
  });

  it("is refused anywhere but on GitHub, or without both its owner and its name", () => {
    for (const input of [
      "https://gitlab.com/someone/site",
      "site",
      "a/b/c",
      "https://github.com/a",
      "../x",
    ]) {
      expect(() => parseRepository(input)).toThrow(/GitHub repository/);
    }
  });

  it("gives its folder and its preview names that fit an address", () => {
    expect(folderName(parseRepository("Owner/Un.Mot_Par--Jour"))).toBe("un-mot-par-jour");
    expect(previewName("lovable", "un-mot-par-jour-landing")).toBe("un-mot-par-jour-landing-preview");
    const long = previewName("lovable", "a-very-long-repository-name-that-keeps-going-and-going-on");
    expect(`lovable-${long}`.length).toBeLessThanOrEqual(63);
    expect(long.endsWith("-preview")).toBe(true);
    expect(long).not.toContain("--preview");
  });
});

describe("the copy script's answer", () => {
  it("is its last marked line, and nothing without one", () => {
    expect(readCloneResult('Cloning…\nopsifier-studio-clone {"ok":false,"code":"exists"}\n')).toEqual({
      ok: false,
      code: "exists",
    });
    expect(readCloneResult("Traceback (most recent call last):\n")).toBeNull();
  });
});

describe("a Studio preview's Dockerfile", () => {
  const text = previewDockerfile({ uid: 1000, gid: 1001 });

  it("runs as the agent server's user", () => {
    expect(text).toContain("USER 1000:1001");
    expect(text).toContain("chown -R 1000:1001 /opt/opsifier-studio");
    expect(text).not.toContain("__UID__");
  });

  it("writes the Vite config with its escapes as they are", () => {
    expect(text).toContain('const id = "\\0opsifier-studio-inspector";');
    expect(text).toContain("/vite\\/dist\\/client\\/client\\.mjs/.test(module)");
    expect(text).toContain('code + "\\nimport(" + JSON.stringify(name) + ");\\n"');
    expect(text).toContain("server: { allowedHosts: true }");
  });

  it("leaves the port to the container, and the lockfile alone", () => {
    expect(text).toContain('--port "$PORT"');
    expect(text).toContain("ENV HOME=/tmp PORT=80");
    expect(text).toContain("bun install --no-save");
    expect(text.startsWith("# syntax=docker/dockerfile:1\n")).toBe(true);
  });
});
