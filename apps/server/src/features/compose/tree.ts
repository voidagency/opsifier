import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ComposeIssue } from "@opsifier/contract";
import { parseDocument } from "yaml";
import { conflict } from "../../core/errors";
import { readPlainFile } from "./checkout";
import { type InspectOptions, inspectComposeFile } from "./inspect";
import {
  type BuildInput,
  fromStackFolder,
  linkedMount,
  ownFolderIssues,
  type StackMount,
} from "./own-folder";
import { linkedFileRefusal } from "./refusals";

/** Enough for any real layout, and a bound on what a file can make the panel read. */
const MAX_FILES = 64;

/** Far more than any Compose file needs, and a bound on what one can make the panel hold. */
export const MAX_STACK_FILE_BYTES = 1024 * 1024;

type YamlRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is YamlRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null ? [] : [value]);

/** An address Compose would fetch rather than read: the file's own check refuses those. */
const REMOTE = /^(?:[a-z][a-z0-9+.-]*:\/\/|[^\s/:@]+@[^\s/:]+:)/i;

/** A path Compose reads from the disk as written, rather than fetching it or filling it in. */
const isLocal = (path: unknown): path is string =>
  typeof path === "string" && !REMOTE.test(path) && !path.includes("$");

/** Codes that only make sense for the file the stack starts from, not for one it brings in. */
const WHOLE_STACK_ONLY = new Set(["no_services", "unknown_dependency"]);

interface Pending {
  /** Where Compose reads the file: joined from the folder its includer's paths start from. */
  file: string;
  /** Where its own relative paths start: its project folder, or its own folder for an extended file. */
  directory: string;
}

/** What one file brings in, and why it can't be followed the way Compose would. */
interface References {
  files: Pending[];
  /** Why Compose could read one of them from somewhere else than this would. */
  unsure: string | null;
}

/**
 * The local files a Compose file brings in, where Compose reads them: an `include` or an `extends`
 * names its file from the folder the including file's paths start from, and an included file's paths
 * start from its `project_directory`, or its own folder. When that folder is not the file's own, where a
 * relative `include` or `extends` leads depends on which of the two Compose takes it from, and an
 * include of several files at once gives the later ones the first one's folder: neither is followed.
 */
function referencedFiles(model: YamlRecord, from: Pending): References {
  const files: Pending[] = [];
  let unsure: string | null = null;
  let relative = false;
  for (const entry of asList(model.include)) {
    const record = isRecord(entry) ? entry : { path: entry };
    const paths = asList(record.path).filter(isLocal);
    if (asList(record.path).length > 1) {
      unsure = `it includes several files at once (${asList(record.path).map(String).join(", ")}). Include each one on its own`;
    }
    const project = record.project_directory;
    // Compose takes an absolute folder as it is, and `~` as the home of whoever runs it, both outside
    // the stack: the file's own check refuses them, and nothing is followed from there.
    if (typeof project === "string" && (isAbsolute(project) || project.startsWith("~"))) {
      continue;
    }
    for (const path of paths) {
      relative ||= !isAbsolute(path);
      const file = isAbsolute(path) ? path : join(from.directory, path);
      files.push({
        file,
        directory: typeof project === "string" ? join(from.directory, project) : dirname(file),
      });
    }
  }
  const services = isRecord(model.services) ? model.services : {};
  for (const child of Object.values(services)) {
    const path = isRecord(child) && isRecord(child.extends) ? child.extends.file : undefined;
    if (isLocal(path)) {
      relative ||= !isAbsolute(path);
      const file = isAbsolute(path) ? path : join(from.directory, path);
      files.push({ file, directory: dirname(file) });
    }
  }
  if (relative && unsure === null && from.directory !== dirname(from.file)) {
    unsure =
      "it includes or extends files by a relative path, and is not in the folder its paths start from, so Compose could read them from another place than its own folder. Keep a file that includes or extends others in the folder its paths start from: for the stack's own file, set the build path to the folder that holds it";
  }
  return { files, unsure };
}

/** The file as a value, read as its own check reads it. Null for one that check could not read. */
function readModel(text: string): YamlRecord | null {
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

export interface StackFiles {
  issues: ComposeIssue[];
  /**
   * Every file Compose reads to know what the stack is, `.env` and env files among them, by absolute
   * path. None is reached through a link, so where the files name it is where it really is.
   */
  files: string[];
  /** What stops the stack before Compose reads anything: a file it can't read as Compose would. */
  refusal: Error | null;
}

/**
 * Checks every file a stack's Compose file brings in through `include` and `extends`, like the file
 * itself, before Compose reads any of them: Compose reads or fetches what they name while it loads
 * them, so this is the last point where that can be refused. A file brought in has to be in the
 * stack's folder, reached through folders alone, plain, and readable by the panel as Compose reads it,
 * and what it names is judged from where Compose reads it. What one file mounts is then held against
 * what every other file mounts or is.
 */
export async function inspectStackFiles(
  projectDirectory: string,
  composeFile: string,
  options: InspectOptions,
): Promise<StackFiles> {
  const root = await realpath(projectDirectory);
  const issues = new Map<string, ComposeIssue>();
  const add = (issue: ComposeIssue) => issues.set(`${issue.code}|${issue.service}|${issue.detail}`, issue);
  const escapes = (detail: string) =>
    add({ severity: "error", code: "escapes_stack", service: null, detail });
  const mounts: StackMount[] = [];
  const inputs: BuildInput[] = [];
  const files = new Set<string>();
  const shown = (path: string) => {
    const inside = fromStackFolder(root, path);
    return inside === null ? path : `./${inside}`;
  };
  const stop = (file: string, why: string): StackFiles => ({
    issues: [...issues.values()],
    files: [],
    refusal: conflict("compose_invalid", `This Compose file can't run: ${shown(file)} ${why}.`),
  });

  const seen = new Set<string>();
  // The file the stack starts from takes its relative paths from the folder Compose is given.
  const queue: Pending[] = [{ file: composeFile, directory: projectDirectory }];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const inside = fromStackFolder(root, next.file);
    const directory = fromStackFolder(root, next.directory);
    if (inside === null || directory === null) {
      // Missing from the stack, or something Compose would fetch from elsewhere.
      escapes(inside === null ? next.file : next.directory);
      continue;
    }
    const key = `${next.file}\n${next.directory}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (seen.size > MAX_FILES) {
      escapes(`more than ${MAX_FILES} files`);
      break;
    }
    const linked = await linkedMount(root, [{ service: null, path: next.file }]);
    if (linked !== null) {
      return { issues: [...issues.values()], files: [], refusal: linkedFileRefusal(linked) };
    }
    const text = await readPlainFile(root, next.file, MAX_STACK_FILE_BYTES);
    if (text === null) {
      escapes(inside);
      continue;
    }
    files.add(inside);
    const nested = next.file !== composeFile;
    const inspection = inspectComposeFile(text, { ...options, base: directory });
    const model = inspection.parseError === null ? readModel(text) : null;
    if (model === null) {
      return stop(
        next.file,
        `can't be read the way Compose would read it (${inspection.parseError ?? "not a Compose file"}), so nothing could tell what it brings in`,
      );
    }
    for (const issue of inspection.issues) {
      if (!(nested && WHOLE_STACK_ONLY.has(issue.code))) {
        add(issue);
      }
    }
    mounts.push(...inspection.mounts);
    inputs.push(...inspection.inputs);
    for (const file of inspection.files) {
      files.add(file);
    }
    const references = referencedFiles(model, next);
    if (references.unsure !== null) {
      return stop(next.file, `can't be followed: ${references.unsure}`);
    }
    queue.push(...references.files);
  }
  // Compose reads all of these as it loads the stack: a link in the way would lead it anywhere.
  const absolute = [...files].map((file) => join(root, file));
  const linked = await linkedMount(
    root,
    absolute.map((path) => ({ service: null, path })),
  );
  if (linked !== null) {
    return { issues: [...issues.values()], files: [], refusal: linkedFileRefusal(linked) };
  }
  for (const issue of ownFolderIssues(mounts, [...files], inputs)) {
    add(issue);
  }
  return { issues: [...issues.values()], files: absolute, refusal: null };
}
