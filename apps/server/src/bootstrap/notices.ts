/**
 * Writes what the panel's image owes the software inside it, while the image is built:
 *
 *   bun apps/server/src/bootstrap/notices.ts <repository> <output-dir>
 *
 * - `THIRD-PARTY-NOTICES.txt`: the license of every program in the image (from `licenses/`) and of
 *   every JavaScript package whose code the server or the web app ships, with each one's own texts;
 * - `components.json`: the same list, for the About page;
 * - `LICENSE` and `NOTICE`: Opsifier's own.
 *
 * A package is shipped when the server or the web app depends on it at run time, directly or
 * through another package: `dependencies` and installed `optionalDependencies`, never
 * `devDependencies`. The workspaces' own packages are Opsifier, so only their dependencies count.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

export interface Component {
  name: string;
  /** Null for a program whose version is whatever its own repository had when the image was built. */
  version: string | null;
  /** An SPDX expression, as the component states it. */
  license: string;
  url: string | null;
  kind: "program" | "package";
}

interface Program extends Omit<Component, "kind"> {
  /** Its license texts, in `licenses/`. */
  files: string[];
}

interface Notice extends Component {
  texts: string[];
}

interface PackageJson {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  licenses?: Array<{ type?: string }>;
  homepage?: string;
  repository?: string | { url?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** The workspaces whose code ends up in the image. */
export const SHIPPED_WORKSPACES = ["apps/server", "apps/web"];

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/** As Node looks a package up: `node_modules/<name>` in the nearest folder going up, to the repository. */
function locate(name: string, from: string, root: string): string | null {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
    if (dir === root || dirname(dir) === dir) {
      return null;
    }
    dir = dirname(dir);
  }
}

function licenseOf(manifest: PackageJson): string {
  if (typeof manifest.license === "string" && manifest.license.trim() !== "") {
    return manifest.license.trim();
  }
  if (typeof manifest.license === "object" && manifest.license?.type) {
    return manifest.license.type;
  }
  const old = (manifest.licenses ?? []).map((entry) => entry.type).filter(Boolean);
  return old.length > 0 ? old.join(" OR ") : "UNKNOWN";
}

function urlOf(manifest: PackageJson, name: string): string {
  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  if (manifest.homepage?.startsWith("http")) {
    return manifest.homepage;
  }
  if (repository !== undefined) {
    const cleaned = repository
      .replace(/^git\+/, "")
      .replace(/^git:\/\//, "https://")
      .replace(/^ssh:\/\/git@/, "https://")
      .replace(/\.git$/, "");
    if (cleaned.startsWith("http")) {
      return cleaned;
    }
    if (/^github:|^[\w.-]+\/[\w.-]+$/.test(cleaned)) {
      return `https://github.com/${cleaned.replace(/^github:/, "")}`;
    }
  }
  return `https://www.npmjs.com/package/${name}`;
}

async function licenseTexts(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter((name) => LICENSE_FILE.test(name)).sort();
  const texts: string[] = [];
  for (const name of names) {
    try {
      texts.push((await readFile(join(dir, name), "utf8")).trim());
    } catch {
      // A folder named like a license file: nothing to read.
    }
  }
  return texts;
}

/** Every package the shipped workspaces need at run time, once each, by name and version. */
export async function shippedPackages(root: string): Promise<Notice[]> {
  const realRoot = await realpath(root);
  const found = new Map<string, Notice>();
  const visited = new Set<string>();
  const queue: string[] = SHIPPED_WORKSPACES.map((workspace) => join(realRoot, workspace));

  while (queue.length > 0) {
    const dir = queue.shift() as string;
    if (visited.has(dir)) {
      continue;
    }
    visited.add(dir);
    const manifest = await readJson<PackageJson>(join(dir, "package.json"));
    const inNodeModules = relative(realRoot, dir).split(sep).includes("node_modules");
    if (inNodeModules) {
      const name = manifest.name ?? relative(realRoot, dir);
      const key = `${name}@${manifest.version ?? "?"}`;
      if (!found.has(key)) {
        found.set(key, {
          name,
          version: manifest.version ?? null,
          license: licenseOf(manifest),
          url: urlOf(manifest, name),
          kind: "package",
          texts: await licenseTexts(dir),
        });
      }
    }
    const wanted = { ...manifest.dependencies, ...manifest.optionalDependencies };
    for (const name of Object.keys(wanted)) {
      const located = locate(name, dir, realRoot);
      if (located === null) {
        if (manifest.optionalDependencies?.[name] !== undefined) {
          continue;
        }
        throw new Error(`${name}, which ${manifest.name ?? dir} needs, is not installed.`);
      }
      queue.push(await realpath(located));
    }
  }
  return [...found.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || (a.version ?? "").localeCompare(b.version ?? ""),
  );
}

export async function shippedPrograms(root: string): Promise<Notice[]> {
  const programs = await readJson<Program[]>(join(root, "licenses", "programs.json"));
  const notices: Notice[] = [];
  for (const { files, ...program } of programs) {
    const texts = await Promise.all(
      files.map(async (file) => (await readFile(join(root, "licenses", file), "utf8")).trim()),
    );
    notices.push({ ...program, kind: "program", texts });
  }
  return notices;
}

const RULE = "=".repeat(78);

function noticesText(notices: readonly Notice[]): string {
  const parts = [
    "Opsifier: third-party notices",
    "",
    "Opsifier is licensed under the Apache License, Version 2.0 (LICENSE, next to this file).",
    "The image also holds the programs and JavaScript packages below, each under its own license,",
    "whose texts follow. The Debian packages in the image keep theirs in /usr/share/doc/<package>/copyright,",
    "and their source code is at https://sources.debian.org.",
  ];
  for (const notice of notices) {
    parts.push(
      "",
      RULE,
      `${notice.name}${notice.version === null ? "" : ` ${notice.version}`}`,
      `License: ${notice.license}`,
      ...(notice.url === null ? [] : [notice.url]),
      RULE,
      "",
      notice.texts.length > 0
        ? notice.texts.join("\n\n")
        : `This package has no license file. Its package.json states: ${notice.license}.`,
    );
  }
  return `${parts.join("\n")}\n`;
}

export async function writeNotices(root: string, output: string): Promise<Component[]> {
  const notices = [...(await shippedPrograms(root)), ...(await shippedPackages(root))];
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "THIRD-PARTY-NOTICES.txt"), noticesText(notices));
  const components = notices.map(({ texts: _texts, ...component }) => component);
  await writeFile(join(output, "components.json"), `${JSON.stringify(components, null, 2)}\n`);
  await copyFile(join(root, "LICENSE"), join(output, "LICENSE"));
  await copyFile(join(root, "NOTICE"), join(output, "NOTICE"));
  return components;
}

if (process.argv[1]?.endsWith("notices.ts")) {
  const [root, output] = process.argv.slice(2);
  if (root === undefined || output === undefined) {
    console.error("Usage: bun apps/server/src/bootstrap/notices.ts <repository> <output-dir>");
    process.exit(2);
  }
  const components = await writeNotices(root, output);
  const unknown = components.filter((component) => component.license === "UNKNOWN");
  console.log(`Notices written for ${components.length} components.`);
  if (unknown.length > 0) {
    console.log(`No license stated: ${unknown.map((component) => component.name).join(", ")}`);
  }
}
