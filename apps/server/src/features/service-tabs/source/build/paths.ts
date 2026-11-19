import { realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";

/** A build setting that points somewhere it must not. Shown as is on the deployment. */
export class SourcePathError extends Error {
  override readonly name = "SourcePathError";
}

const isInside = (root: string, candidate: string) =>
  candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** Characters some readers of a path change or stop at: a CSV reader turns `\r\n` into `\n`. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters to refuse
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A path the disk gave back, as text, only when the text is exactly its bytes and holds no control
 * character. A name that is not UTF-8 reads back with U+FFFD in its place, which writes back as other
 * bytes: another entry, which the repository can make a link to anywhere. What was checked would then
 * not be what a tool is given.
 */
export function exactPath(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) && !CONTROL.test(text) ? text : null;
}

/**
 * Resolves a path from the repository and checks where it really leads. The settings were validated
 * when saved, but only here does the checkout exist, and a symlink in it can point anywhere.
 */
export async function resolveInside(root: string, relative: string, what: string): Promise<string> {
  const realRoot = await realpath(root);
  let bytes: Buffer;
  try {
    bytes = await realpath(join(realRoot, relative), { encoding: "buffer" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SourcePathError(`${what} does not exist in the source: ${relative || "/"}.`);
    }
    throw error;
  }
  const real = exactPath(bytes);
  if (real === null) {
    throw new SourcePathError(
      `${what} goes through a name that is not plain UTF-8 text, or holds a control character: ${relative || "/"}. Rename it in the source.`,
    );
  }
  if (!isInside(realRoot, real)) {
    throw new SourcePathError(`${what} leaves the source: ${relative || "/"}.`);
  }
  return real;
}

export async function assertDirectory(path: string, what: string, shown: string): Promise<void> {
  if (!(await stat(path)).isDirectory()) {
    throw new SourcePathError(`${what} is not a directory: ${shown}.`);
  }
}

export async function assertFile(path: string, what: string, shown: string): Promise<void> {
  if (!(await stat(path)).isFile()) {
    throw new SourcePathError(`${what} is not a file: ${shown}.`);
  }
}

export { isInside };
