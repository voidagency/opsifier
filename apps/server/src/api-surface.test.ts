import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiDocument, diffSurfaces, surfaceLines } from "./testing/api-surface";
import { call, createTestContext, setupAdmin, type TestContext } from "./testing/harness";

/**
 * The contract under /api/v1 is stable: anything a client can rely on stays, and a change that would
 * break one takes a new path. This holds the document to a checked-in record of that surface, so that
 * every change to the public API shows up in a diff, and in `docs/API.md`, before it ships.
 */
const SURFACE_FILE = join(import.meta.dirname, "../../../docs/api-surface.txt");
const CHANGELOG_FILE = join(import.meta.dirname, "../../../docs/API.md");
const REFRESH = "UPDATE_API_SURFACE=1 bunx vitest run apps/server/src/api-surface.test.ts";

/** Rows of the Changes table in docs/API.md: one per recorded change to the API. */
function changeRowsInDocs(): number {
  const section = readFileSync(CHANGELOG_FILE, "utf8").split("## Changes")[1] ?? "";
  return section.split("\n").filter((line) => /^\| \d{4}-\d{2}-\d{2}/.test(line)).length;
}

function readBaseline(): { documentedChanges: number; lines: string[] } {
  const text = readFileSync(SURFACE_FILE, "utf8");
  const header = /# documented-changes: (\d+)/.exec(text);
  return {
    documentedChanges: Number(header?.[1]),
    lines: text.split("\n").filter((line) => line !== "" && !line.startsWith("#")),
  };
}

function format(documentedChanges: number, lines: readonly string[]): string {
  return [
    "# The public API, one fact per line. Generated: see apps/server/src/api-surface.test.ts.",
    "# Operation, then its inputs and each field of its answers (`!` means required).",
    `# documented-changes: ${documentedChanges}`,
    ...lines,
    "",
  ].join("\n");
}

describe("the public API", () => {
  let context: TestContext;
  let current: string[];

  beforeAll(async () => {
    context = await createTestContext();
    const cookie = await setupAdmin(context.app);
    const result = await call<ApiDocument>(context.app, "/api/v1/openapi.json", { cookie });
    current = surfaceLines(result.body);
  });

  afterAll(async () => {
    await context.close();
  });

  it("matches the record of its surface, and every change to it is written down", () => {
    const rows = changeRowsInDocs();
    const baseline = readBaseline();
    const changed = baseline.lines.join("\n") !== current.join("\n");
    const { breaking, additions } = diffSurfaces(baseline.lines, current);

    if (process.env.UPDATE_API_SURFACE === "1") {
      expect(
        !changed || rows > baseline.documentedChanges,
        "Add a row to the Changes table in docs/API.md saying what changed, then refresh again.",
      ).toBe(true);
      writeFileSync(SURFACE_FILE, format(Math.max(rows, baseline.documentedChanges), current));
      return;
    }

    if (changed) {
      const report = [
        "The public API no longer matches docs/api-surface.txt.",
        ...(breaking.length === 0
          ? []
          : ["", "This can break existing clients:", ...breaking.map((line) => `  - ${line}`)]),
        ...(additions.length === 0 ? [] : ["", "Added:", ...additions.map((line) => `  + ${line}`)]),
        "",
        "If this is intended: say what changed in the Changes table of docs/API.md (a change that would",
        `break a client should get a new path instead), then record it with: ${REFRESH}`,
      ].join("\n");
      expect.fail(report);
    }

    expect(
      rows,
      `docs/API.md's Changes table lost rows: it had ${baseline.documentedChanges} when this was last recorded.`,
    ).toBeGreaterThanOrEqual(baseline.documentedChanges);
  });
});

describe("telling a breaking change from an addition", () => {
  const base = ["GET /api/v1/things", "  200 items[].name!: string", "  query limit: integer"];

  it("sees nothing when nothing changed", () => {
    expect(diffSurfaces(base, base)).toEqual({ breaking: [], additions: [] });
  });

  it("calls a removed operation breaking, and a new one an addition", () => {
    expect(diffSurfaces([...base, "POST /api/v1/old"], base).breaking).toEqual(["POST /api/v1/old"]);
    expect(diffSurfaces(base, [...base, "POST /api/v1/new", "  body name!: string"]).additions).toEqual([
      "POST /api/v1/new",
      "POST /api/v1/new  body name!: string",
    ]);
  });

  it("calls a removed or retyped answer field breaking", () => {
    const removed = ["GET /api/v1/things", "  query limit: integer"];
    expect(diffSurfaces(base, removed).breaking).toEqual(["GET /api/v1/things  200 items[].name!: string"]);

    const retyped = ["GET /api/v1/things", "  200 items[].name!: integer", "  query limit: integer"];
    expect(diffSurfaces(base, retyped).breaking).toEqual(["GET /api/v1/things  200 items[].name!: string"]);
  });

  it("calls a new optional field an addition, and a new required input breaking", () => {
    const optional = [...base, "  query cursor: string", "  200 items[].size: integer"];
    expect(diffSurfaces(base, optional)).toEqual({
      breaking: [],
      additions: [
        "GET /api/v1/things  200 items[].size: integer",
        "GET /api/v1/things  query cursor: string",
      ],
    });

    const required = [...base, "  query cursor!: string"];
    expect(diffSurfaces(base, required).breaking).toEqual(["GET /api/v1/things  query cursor!: string"]);
  });

  it("calls a required field inside a new optional object an addition", () => {
    const nested = [...base, "  body settings.name!: string"];
    expect(diffSurfaces(base, nested)).toEqual({
      breaking: [],
      additions: ["GET /api/v1/things  body settings.name!: string"],
    });
  });
});
