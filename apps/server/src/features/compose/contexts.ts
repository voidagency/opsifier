import { posix } from "node:path";
import { conflict } from "../../core/errors";
import { readStackBytes } from "./checkout";
import { fromStackFolder } from "./own-folder";
import type { ResolvedInput, StackBind } from "./resolved";

/**
 * A build sends its context in two steps: it walks the folder, then opens each file the builder asks
 * for by its path, following any link that took the place of the file, or of a folder above it, in
 * between. A container that writes inside the context can make that swap at the right moment and have
 * the panel's own files sent into an image, or fill the builder's disk. So a context may only hold a
 * folder a container mounts read-write when the build never walks into it: its ignore file leaves the
 * folder out by name, with no exception that could bring part of it back.
 */

/** Far more than any ignore file needs, and a bound on what one can make the panel hold. */
const MAX_IGNORE_BYTES = 1024 * 1024;

/** What a build reads as a context, and the folders in it that it never walks. */
export interface ContextRead {
  service: string;
  /** `context` or `additional_contexts`, as Compose calls it. */
  field: string;
  /** The context, by absolute path. */
  path: string;
  /** Folders of it the build never walks, from the context. */
  excluded: string[];
  /** The ignore file that leaves them out, by absolute path, when one does. */
  ignoreFile: string | null;
}

/**
 * Printable ASCII, tabs and line breaks: all an ignore file needs to name folders. BuildKit reads a
 * line by Go's rules, which differ from JavaScript's on characters such as U+0085, which Go trims and
 * so can make it read an exception line the panel would not, and U+FEFF past the first line, which
 * JavaScript trims and Go keeps in a name. A file with anything else is not read for exclusions.
 */
const PLAIN_IGNORE_FILE = /^[\t\n\r\x20-\x7e]*$/;

/**
 * The folders an ignore file leaves out for sure: lines that name one path plainly, without a pattern,
 * in a file without an exception line, since an exception can bring back part of what a line left out,
 * and the walk then goes into the folder to look for it.
 */
export function excludedFolders(text: string): string[] {
  if (!PLAIN_IGNORE_FILE.test(text)) {
    return [];
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.some((line) => line.startsWith("!"))) {
    return [];
  }
  return lines.flatMap((line) => {
    if (/[*?[\]\\]/.test(line)) {
      return [];
    }
    const clean = posix.normalize(line.replace(/^\/+/, "")).replace(/\/+$/, "");
    return clean === "" || clean === "." || clean === ".." || clean.startsWith("../") ? [] : [clean];
  });
}

/** Whether a path inside a context, from the context, lies in a folder the build never walks. */
export const isExcluded = (path: string, excluded: readonly string[]): boolean =>
  excluded.some((folder) => path === folder || path.startsWith(`${folder}/`));

/**
 * Reads the ignore file of every context the builds use: the one beside a build's Dockerfile when it
 * has one, as BuildKit takes it, and the context's own `.dockerignore` otherwise. An ignore file that
 * is not a plain file of the stack stops the deploy, since nothing could say what the build walks.
 */
export async function readContexts(root: string, inputs: readonly ResolvedInput[]): Promise<ContextRead[]> {
  const dockerfiles = new Map(
    inputs.filter((input) => input.field === "dockerfile").map((input) => [input.service, input.path]),
  );
  const contexts: ContextRead[] = [];
  for (const input of inputs) {
    if (input.field !== "context" && input.field !== "additional_contexts") {
      continue;
    }
    const dockerfile = input.field === "context" ? dockerfiles.get(input.service ?? "") : undefined;
    const candidates = [
      ...(dockerfile === undefined ? [] : [`${dockerfile}.dockerignore`]),
      posix.join(input.path, ".dockerignore"),
    ];
    let excluded: string[] = [];
    let ignoreFile: string | null = null;
    for (const candidate of candidates) {
      const read = await readStackBytes(root, candidate, MAX_IGNORE_BYTES);
      if (read === "missing") {
        continue;
      }
      if (read === "not_plain" || read === "too_large") {
        const shown = fromStackFolder(root, candidate);
        throw conflict(
          "compose_invalid",
          `This Compose file can't run: ${shown === null ? candidate : `./${shown}`}, which says what the build of ${input.service} leaves out, is not a plain file of at most 1 MiB, so nothing could say what that build reads.`,
        );
      }
      excluded = excludedFolders(read.toString("utf8"));
      ignoreFile = candidate;
      break;
    }
    contexts.push({
      service: input.service ?? "",
      field: input.field,
      path: input.path,
      excluded,
      ignoreFile,
    });
  }
  return contexts;
}

/** What a context holds that a container can write and the build would walk. */
export interface WritableInContext {
  context: ContextRead;
  mount: StackBind;
  /** The mount, from the context. */
  path: string;
}

/** The first folder a child mounts read-write inside a context, where the build would walk it. */
export function writableInContext(
  contexts: readonly ContextRead[],
  mounts: readonly StackBind[],
): WritableInContext | null {
  for (const context of contexts) {
    for (const mount of mounts) {
      if (!mount.writable || !mount.path.startsWith(`${context.path}/`)) {
        continue;
      }
      const path = mount.path.slice(context.path.length + 1);
      if (!isExcluded(path, context.excluded)) {
        return { context, mount, path };
      }
    }
  }
  return null;
}

/**
 * The ignore files of the contexts, which say what a build leaves out: a build input like the rest,
 * which nothing may change between the check and the build.
 */
export const ignoreInputs = (contexts: readonly ContextRead[]): ResolvedInput[] =>
  contexts.flatMap((context) =>
    context.ignoreFile === null
      ? []
      : [{ service: context.service, path: context.ignoreFile, field: "dockerignore", written: false }],
  );
