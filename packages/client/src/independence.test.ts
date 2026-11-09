import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The command line and the MCP server are API clients and nothing else. These packages must not be
 * able to reach the panel's database, its Docker socket or its code by any other route.
 */
const ROOT = join(import.meta.dirname, "../..");
const PACKAGES = ["client", "cli", "mcp"];

const FORBIDDEN_IMPORT =
  /from\s+["'](?:better-sqlite3|dockerode|drizzle-orm|ssh2|ws|node:child_process|node:net|node:dgram|[^"']*apps\/server[^"']*)["']/;

function sourcesOf(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return sourcesOf(path);
    }
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

describe("the API clients", () => {
  it.each(PACKAGES)("%s depends on nothing but workspace packages", (name) => {
    const manifest = JSON.parse(readFileSync(join(ROOT, name, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const [dependency, version] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      expect(`${dependency}@${version}`).toMatch(/^@opsifier\/[a-z-]+@workspace:\*$/);
    }
  });

  it.each(PACKAGES)("%s imports no way around the API", (name) => {
    for (const file of sourcesOf(join(ROOT, name, "src"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(FORBIDDEN_IMPORT);
    }
  });
});
