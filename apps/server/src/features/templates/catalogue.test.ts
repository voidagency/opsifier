import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isFixedDatabaseImage,
  isPinnedImage,
  type TemplateDocument,
  templateCategories,
  templateDocument,
} from "@opsifier/contract";
import { describe, expect, it } from "vitest";
import { findTemplatesDir, loadCatalogue } from "./catalogue";

const directory = findTemplatesDir() as string;
const files = readdirSync(directory).filter((name) => name.endsWith(".json"));

/** The only templates that may claim to be verified: each one is covered by templates.e2e.test.ts. */
const VERIFIED_ON_REAL_DOCKER = new Set(["gotify", "it-tools", "miniflux"]);

describe("the template catalogue", () => {
  it("offers at least thirty applications", () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  it("loads every file with nothing left out", () => {
    const { templates, problems } = loadCatalogue(directory);
    expect(problems).toEqual([]);
    expect(templates.map((template) => template.id)).toEqual(
      files.map((file) => file.replace(/\.json$/, "")),
    );
  });

  describe.each(files)("%s", (file) => {
    const document: TemplateDocument = templateDocument.parse(
      JSON.parse(readFileSync(join(directory, file), "utf8")),
    );

    it("is named after its id and versioned", () => {
      expect(document.id).toBe(file.replace(/\.json$/, ""));
      expect(document.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it("pins every image", () => {
      for (const service of document.services) {
        if (service.kind === "database") {
          expect(isPinnedImage(service.image), service.image).toBe(true);
        } else if (service.kind === "app" && service.source.type === "image") {
          expect(isPinnedImage(service.source.image), service.source.image).toBe(true);
        }
      }
    });

    it("starts every database on a version that does not move by itself", () => {
      for (const service of document.services) {
        if (service.kind === "database") {
          expect(isFixedDatabaseImage(service.image), service.image).toBe(true);
        }
      }
    });

    it("has text in both languages and a known category", () => {
      expect(templateCategories).toContain(document.category);
      expect(document.summary.fr).not.toBe("");
      expect(document.description.fr).not.toBe("");
      expect(document.summary.en).not.toBe(document.summary.fr);
    });

    it("declares a start-up test for what it publishes", () => {
      for (const service of document.services) {
        if (service.kind !== "database" && service.domain !== null) {
          expect(service.startup).not.toBeNull();
        }
      }
    });

    it("links only to the application's own https pages", () => {
      expect(document.links.length).toBeGreaterThan(0);
      for (const link of document.links) {
        expect(link.url.startsWith("https://")).toBe(true);
      }
    });

    it("claims verification only with a real fixture", () => {
      expect(document.verified).toBe(VERIFIED_ON_REAL_DOCKER.has(document.id));
    });
  });
});
