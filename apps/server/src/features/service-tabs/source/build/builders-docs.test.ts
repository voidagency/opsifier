import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildpackLanguages,
  buildpacksBuilders,
  nixpacksLanguages,
  nixpacksVersions,
  packVersion,
  railpackLanguages,
  railpackVersions,
} from "@opsifier/contract";
import { describe, expect, it } from "vitest";

/** The published matrix can't be allowed to drift from what the panel offers. */
const doc = readFileSync(join(import.meta.dirname, "../../../../../../../docs/BUILDERS.md"), "utf8");

const section = (heading: string): string => {
  const start = doc.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const next = doc.indexOf("\n#", start + heading.length);
  return doc.slice(start, next === -1 ? undefined : next);
};

describe("the published builder matrix", () => {
  it("lists every Nixpacks version and what it detects", () => {
    const nixpacks = section("### Nixpacks");
    for (const version of nixpacksVersions) {
      expect(nixpacks).toContain(version);
    }
    for (const language of nixpacksLanguages) {
      expect(nixpacks).toContain(language);
    }
  });

  it("gives each Railpack version the languages it really detects", () => {
    const railpack = section("### Railpack");
    for (const version of railpackVersions) {
      const row = railpack.split("\n").find((line) => line.includes(` ${version}`) && line.startsWith("|"));
      expect(row, version).toBeDefined();
      for (const language of railpackLanguages(version)) {
        expect(row, `${version} ${language}`).toContain(language);
      }
    }
  });

  it("names every builder image the panel offers and what it packs", () => {
    const buildpacks = section("### Buildpacks");
    expect(buildpacks).toContain(packVersion);
    for (const builder of buildpacksBuilders) {
      const row = buildpacks.split("\n").find((line) => line.includes(builder));
      expect(row, builder).toBeDefined();
      for (const language of buildpackLanguages(builder) ?? []) {
        expect(row, `${builder} ${language}`).toContain(language);
      }
    }
  });

  it("states what a forced rebuild refreshes, builder by builder", () => {
    const forced = section("## Forced rebuilds");
    for (const builder of ["Dockerfile", "Railpack", "Buildpacks", "Nixpacks"]) {
      expect(forced).toContain(`| ${builder}`);
    }
    expect(forced).toMatch(/replaced/);
    expect(forced).toMatch(/--pull/);
    expect(forced).toMatch(/--clear-cache/);
  });

  it("says how each builder can be overridden and how it fails", () => {
    for (const heading of ["## Overrides", "## When a build fails"]) {
      const part = section(heading);
      for (const builder of ["Dockerfile", "Nixpacks", "Railpack", "Buildpacks"]) {
        expect(part, `${heading} ${builder}`).toContain(builder);
      }
    }
  });
});
