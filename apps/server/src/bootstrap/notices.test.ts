import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nixpacksVersions, packVersion, railpackVersions } from "@opsifier/contract";
import { afterEach, describe, expect, it } from "vitest";
import { writeNotices } from "./notices";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

interface Program {
  name: string;
  version: string | null;
  files: string[];
}
const programs = JSON.parse(read("licenses/programs.json")) as Program[];
const versionOf = (name: string) => programs.find((program) => program.name === name)?.version;

let output: string;

afterEach(() => {
  rmSync(output, { recursive: true, force: true });
});

const byVersion = (a: string, b: string) => {
  const [x, y] = [a, b].map((value) => value.split(".").map(Number));
  for (let index = 0; index < 3; index += 1) {
    const difference = (x?.[index] ?? 0) - (y?.[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};
const range = (versions: readonly string[]) => {
  const sorted = [...versions].sort(byVersion);
  return `${sorted[0]} to ${sorted.at(-1)}`;
};

describe("the notices the image ships", () => {
  it("hold every program and every package the panel ships, with its license, and no tool of the build", async () => {
    output = mkdtempSync(join(tmpdir(), "opsifier-notices-"));
    const components = await writeNotices(ROOT, output);

    const names = components.map((component) => component.name);
    for (const program of programs) {
      expect(names).toContain(program.name);
    }
    expect(names).toEqual(expect.arrayContaining(["hono", "zod", "react", "better-sqlite3"]));
    expect(names).not.toContain("vitest");
    expect(names).not.toContain("typescript");
    expect(names).not.toContain("@opsifier/contract");
    expect(components.filter((component) => component.license === "UNKNOWN")).toEqual([]);

    const notices = readFileSync(join(output, "THIRD-PARTY-NOTICES.txt"), "utf8");
    expect(notices).toContain("BSD 2-Clause License");
    expect(notices).toContain("Copyright (c) 2014, Alexander Neumann");
    expect(readFileSync(join(output, "LICENSE"), "utf8")).toContain("Apache License");
    expect(readFileSync(join(output, "NOTICE"), "utf8")).toContain("Copyright 2026 Opsifier contributors");
  });

  it("name the versions of the programs the Dockerfile and the contract install", () => {
    const dockerfile = read("Dockerfile");
    expect(versionOf("Node.js")).toBe(/ARG NODE_IMAGE=node:(\d+\.\d+\.\d+)-/.exec(dockerfile)?.[1]);
    expect(versionOf("restic")).toBe(/ARG RESTIC_VERSION=(\S+)/.exec(dockerfile)?.[1]);
    expect(versionOf("pack")).toBe(packVersion);
    expect(versionOf("Nixpacks")).toBe(range(nixpacksVersions));
    expect(versionOf("Railpack")).toBe(range(railpackVersions));
    for (const program of programs) {
      for (const file of program.files) {
        expect(read(join("licenses", file)).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("the image's build context", () => {
  it("lets in everything the Dockerfile copies from it", () => {
    const allowed = read(".dockerignore")
      .split("\n")
      .filter((line) => line.startsWith("!"))
      .map((line) => line.slice(1).replace(/\/$/, ""));
    const sources = read("Dockerfile")
      .split("\n")
      .filter((line) => /^COPY\s/.test(line) && !line.includes("--from="))
      .flatMap((line) => line.trim().split(/\s+/).slice(1, -1));

    expect(sources.length).toBeGreaterThan(10);
    const shut = sources.filter(
      (source) =>
        !allowed.some(
          (path) => path === source || source.startsWith(`${path}/`) || path.startsWith(`${source}/`),
        ),
    );
    expect(shut).toEqual([]);
  });
});
