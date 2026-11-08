import { realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";

/** A build setting that points somewhere it must not. Shown as is on the deployment. */
export class SourcePathError extends Error {
  override readonly name = "SourcePathError";
}

const isInside = (root: string, candidate: string) =>
  candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * Resolves a path from the repository and checks where it really leads. The settings were validated
 * when saved, but only here does the checkout exist, and a symlink in it can point anywhere.
 */
export async function resolveInside(root: string, relative: string, what: string): Promise<string> {
  const realRoot = await realpath(root);
  let real: string;
  try {
    real = await realpath(join(realRoot, relative));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SourcePathError(`${what} does not exist in the source: ${relative || "/"}.`);
    }
    throw error;
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
