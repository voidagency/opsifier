import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import type { ComposeIssue } from "@opsifier/contract";
import { parseDocument } from "yaml";
import { type InspectOptions, inspectComposeFile } from "./inspect";

/** Enough for any real layout, and a bound on what a file can make the panel read. */
const MAX_FILES = 64;

type YamlRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is YamlRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null ? [] : [value]);

/** An address Compose would fetch rather than read: the file's own check refuses those. */
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:\/\/|[^\s/:@]+@[^\s/:]+:)/i;

/** Codes that only make sense for the file the stack starts from, not for one it brings in. */
const WHOLE_STACK_ONLY = new Set(["no_services", "unknown_dependency"]);

const isInside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`);

interface Pending {
  file: string;
  /** Where the file's relative paths start from. Compose lets an include say, and uses the file's folder otherwise. */
  directory: string;
}

function parse(text: string): YamlRecord | null {
  const document = parseDocument(text, { merge: true });
  if (document.errors.length > 0) {
    return null;
  }
  try {
    const value = document.toJS({ maxAliasCount: 200 });
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The local files a Compose file brings in, with the folder each one's own paths start from. */
function referencedFiles(model: YamlRecord, file: string): Pending[] {
  const here = dirname(file);
  const found: Pending[] = [];
  for (const entry of asList(model.include)) {
    const record = isRecord(entry) ? entry : { path: entry };
    const directory =
      typeof record.project_directory === "string" ? join(here, record.project_directory) : null;
    for (const path of asList(record.path)) {
      if (typeof path === "string" && !REMOTE.test(path) && !path.includes("$")) {
        const target = isAbsolute(path) ? path : join(here, path);
        found.push({ file: target, directory: directory ?? dirname(target) });
      }
    }
  }
  const services = isRecord(model.services) ? model.services : {};
  for (const child of Object.values(services)) {
    const file_ = isRecord(child) && isRecord(child.extends) ? child.extends.file : undefined;
    if (typeof file_ === "string" && !REMOTE.test(file_) && !file_.includes("$")) {
      const target = isAbsolute(file_) ? file_ : join(here, file_);
      found.push({ file: target, directory: dirname(target) });
    }
  }
  return found;
}

/**
 * Checks every file a stack's Compose file brings in through `include` and `extends`, like the file
 * itself, before Compose reads any of them: Compose reads or fetches what they name while it loads
 * them, so this is the last point where that can be refused. A file brought in has to be in the
 * stack's folder, and what it names is judged from where Compose reads it.
 */
export async function inspectStackFiles(
  projectDirectory: string,
  composeFile: string,
  options: InspectOptions,
): Promise<ComposeIssue[]> {
  const root = await realpath(projectDirectory);
  const issues = new Map<string, ComposeIssue>();
  const add = (issue: ComposeIssue) => issues.set(`${issue.code}|${issue.service}|${issue.detail}`, issue);
  const refuse = (detail: string) => add({ severity: "error", code: "escapes_stack", service: null, detail });

  const seen = new Set<string>();
  const head = await realpath(composeFile).catch(() => composeFile);
  // The file the stack starts from takes its relative paths from the folder Compose is given.
  const queue: Pending[] = [{ file: composeFile, directory: projectDirectory }];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const shown = relative(root, next.file) || next.file;
    let real: string;
    try {
      // A file the stack doesn't hold is either missing or something Compose would go and fetch.
      real = await realpath(next.file);
      if (!(await lstat(real)).isFile()) {
        throw new Error("not a file");
      }
    } catch {
      refuse(shown);
      continue;
    }
    if (!isInside(root, real)) {
      refuse(shown);
      continue;
    }
    const directory = await realpath(next.directory).catch(() => next.directory);
    if (!isInside(root, directory)) {
      refuse(relative(root, next.directory) || next.directory);
      continue;
    }
    const key = `${real}\n${directory}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (seen.size > MAX_FILES) {
      refuse(`more than ${MAX_FILES} files`);
      break;
    }

    const text = await readFile(real, "utf8");
    const base = relative(root, directory).split(sep).join(posix.sep) || ".";
    const nested = real !== head;
    for (const issue of inspectComposeFile(text, { ...options, base }).issues) {
      if (!(nested && WHOLE_STACK_ONLY.has(issue.code))) {
        add(issue);
      }
    }
    const model = parse(text);
    if (model !== null) {
      queue.push(...referencedFiles(model, real));
    }
  }
  return [...issues.values()];
}
