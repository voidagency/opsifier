import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  copyFile,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  symlink,
  unlink,
} from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { leaves } from "./own-folder";

/**
 * The panel's own work in a stack's folder, which the stack's containers write too: they can leave a
 * link where the panel expects a folder or a file, pointing at the panel's data or another project's.
 * Nothing here follows one. `/proc/self/fd` gives a folder by what was opened rather than by name: each
 * step of a path is opened from the one before it, none of them through a link, and whatever happens to
 * the path afterwards can't move a folder that is open. Linux only; elsewhere, for development, each
 * step is looked at before it is used.
 */

const USES_DIRECTORY_FDS = process.platform === "linux";

const OPEN_DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/** A file being laid down is never visible under its real name until it is whole. */
const TEMPORARY_PREFIX = ".opsifier-";

interface Folder {
  /** One entry of the folder, by name. A link at that name is the link, never where it points. */
  entry(name: string): string;
  close(): Promise<void>;
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

/** What makes a step of a path not a folder to go through: a link, a file, or nothing at all. */
const notAFolder = (error: unknown): boolean =>
  ["ENOENT", "ENOTDIR", "ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "");

const byDescriptor = (handle: FileHandle): Folder => ({
  entry: (name) => `/proc/self/fd/${handle.fd}/${name}`,
  close: () => handle.close(),
});

/** One folder inside another, opened through it. Null when the name is not a folder: a link isn't. */
async function openInside(folder: Folder | string, name: string): Promise<Folder | null> {
  const path = typeof folder === "string" ? folder : folder.entry(name);
  if (USES_DIRECTORY_FDS) {
    try {
      return byDescriptor(await open(path, OPEN_DIRECTORY));
    } catch (error) {
      if (notAFolder(error)) {
        return null;
      }
      throw error;
    }
  }
  const stats = await lstat(path).catch((error: unknown) => {
    if (missing(error)) {
      return null;
    }
    throw error;
  });
  return stats?.isDirectory() === true
    ? { entry: (inner) => join(path, inner), close: async () => {} }
    : null;
}

/** A folder of the tree, step by step from its root. Null when a step is missing, a link or a file. */
async function openFolder(root: string, segments: readonly string[]): Promise<Folder | null> {
  let current = await openInside(root, "");
  for (const segment of segments) {
    if (current === null) {
      return null;
    }
    const next = await openInside(current, segment).finally(() => current?.close());
    current = next;
  }
  return current;
}

const entryStats = (folder: Folder, name: string): Promise<Stats | null> =>
  lstat(folder.entry(name)).catch((error: unknown) => {
    if (missing(error)) {
      return null;
    }
    throw error;
  });

/** A path from a tree's root, split into names that each stay inside it. Null for anything else. */
function segmentsOf(path: string): string[] | null {
  const segments = path.split(sep);
  return path !== "" && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
    ? segments
    : null;
}

/**
 * Removes a file an earlier checkout laid down. A link in its place is removed itself, never what it
 * points at. Where a step on the way is no longer a folder, or a folder now has that name, it is the
 * stack's own: nothing of the checkout is left to remove there.
 */
async function removeStale(code: string, file: string): Promise<void> {
  const segments = segmentsOf(file);
  const name = segments?.pop();
  if (segments === null || name === undefined) {
    return;
  }
  const folder = await openFolder(code, segments);
  if (folder === null) {
    return;
  }
  try {
    const stats = await entryStats(folder, name);
    if (stats !== null && !stats.isDirectory()) {
      await unlink(folder.entry(name));
    }
  } finally {
    await folder.close();
  }
}

const shown = (segments: readonly string[]): string => segments.join(posix.sep);

/**
 * The folder of that name, made if it is missing. A link the stack left where the repository has a
 * folder is removed, never followed. A file there is the stack's, and stops the checkout.
 */
async function layFolder(
  parent: Folder,
  name: string,
  mode: number,
  path: readonly string[],
): Promise<Folder> {
  let stats = await entryStats(parent, name);
  if (stats?.isSymbolicLink() === true) {
    await unlink(parent.entry(name));
    stats = null;
  }
  if (stats === null) {
    await mkdir(parent.entry(name), { mode: mode & 0o777 });
  } else if (!stats.isDirectory()) {
    throw new Error(`The stack's folder has a file where the repository has a folder: ${shown(path)}.`);
  }
  const folder = await openInside(parent, name);
  if (folder === null) {
    throw new Error(`The stack's folder changed while the checkout was laid down: ${shown(path)}.`);
  }
  return folder;
}

/** Puts a file or a link in place under its name all at once. A link already there is replaced, not followed. */
async function layEntry(
  folder: Folder,
  name: string,
  path: readonly string[],
  create: (temporary: string) => Promise<void>,
): Promise<void> {
  const temporary = `${TEMPORARY_PREFIX}${randomBytes(8).toString("hex")}.tmp`;
  await create(folder.entry(temporary));
  try {
    await rename(folder.entry(temporary), folder.entry(name));
  } catch (error) {
    await unlink(folder.entry(temporary)).catch(() => undefined);
    if (["EISDIR", "ENOTEMPTY", "EEXIST", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error(`The stack's folder has a folder where the repository has a file: ${shown(path)}.`);
    }
    throw error;
  }
}

/** Lays one folder of the checkout over its place in the stack's folder, and everything in it. */
async function layTree(source: string, folder: Folder, path: readonly string[]): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const at = [...path, entry.name];
    if (entry.isDirectory()) {
      const inner = await layFolder(folder, entry.name, (await lstat(from)).mode, at);
      try {
        await layTree(from, inner, at);
      } finally {
        await inner.close();
      }
    } else if (entry.isSymbolicLink()) {
      // Checked when the checkout was verified: it stays inside the repository.
      const target = await readlink(from);
      await layEntry(folder, entry.name, at, (temporary) => symlink(target, temporary));
    } else if (entry.isFile()) {
      await layEntry(folder, entry.name, at, (temporary) =>
        copyFile(from, temporary, constants.COPYFILE_EXCL),
      );
    }
  }
}

/** Every file in a tree, as paths from its root. A checkout has been verified before it gets here. */
export async function listFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else {
      files.push(relative(root, path));
    }
  }
  return files;
}

/**
 * Lays a fresh checkout over the stack's folder and answers with the files it brought. Files the
 * previous checkout brought and this one does not are removed, but anything else is the stack's own,
 * written through a relative mount, and stays: a redeploy must not lose what a running stack produced.
 */
export async function syncCheckout(
  staged: string,
  code: string,
  previous: readonly string[],
): Promise<string[]> {
  const incoming = await listFiles(staged);
  const keep = new Set(incoming);
  await mkdir(code, { recursive: true, mode: 0o755 });
  for (const file of previous) {
    if (!keep.has(file)) {
      await removeStale(code, file);
    }
  }
  const root = await openFolder(code, []);
  if (root === null) {
    throw new Error("The stack's folder is not a folder.");
  }
  try {
    await layTree(staged, root, []);
  } finally {
    await root.close();
  }
  return incoming;
}

/** Where a path sits in a tree, as names that stay inside it. Null for the root itself or anything outside. */
function insideTree(root: string, path: string): string[] | null {
  const inside = relative(root, path);
  return leaves(inside) ? null : segmentsOf(inside);
}

/** What reading a file of a stack's folder found, when it found no plain file to read. */
export type Unread = "missing" | "not_plain" | "too_large";

/**
 * Reads a plain file of a stack's folder, never through a link on the way or at the end, and never
 * waiting on something that isn't a file. Says why when there is nothing it may read: a link on the
 * way or at the end, a pipe or a folder is not plain.
 */
export async function readStackBytes(root: string, path: string, maxBytes: number): Promise<Buffer | Unread> {
  const segments = insideTree(root, path);
  const name = segments?.pop();
  if (segments === null || name === undefined) {
    return "not_plain";
  }
  const folder = await openFolder(root, segments);
  if (folder === null) {
    return (await lstat(path).catch(() => null)) === null ? "missing" : "not_plain";
  }
  try {
    // Non-blocking, so that a named pipe someone left behind can't hold the deploy open.
    const handle = await open(
      folder.entry(name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error: unknown): Unread => (missing(error) ? "missing" : "not_plain"));
    if (typeof handle === "string") {
      return handle;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return "not_plain";
      }
      return stats.size > maxBytes ? "too_large" : await handle.readFile();
    } finally {
      await handle.close();
    }
  } finally {
    await folder.close();
  }
}

/**
 * Reads a plain file of a stack's folder, never through a link on the way or at the end. Null when it
 * is missing, not a plain file, larger than allowed, or reached through a link.
 */
export async function readPlainFile(root: string, path: string, maxBytes: number): Promise<string | null> {
  const read = await readStackBytes(root, path, maxBytes);
  return typeof read === "string" ? null : read.toString("utf8");
}

/** Whether anything at all, a link included, has this name in a stack's folder. */
export async function hasEntry(root: string, path: string): Promise<boolean> {
  const segments = insideTree(root, path);
  const name = segments?.pop();
  if (segments === null || name === undefined) {
    return false;
  }
  const folder = await openFolder(root, segments);
  if (folder === null) {
    return false;
  }
  try {
    return (await entryStats(folder, name)) !== null;
  } finally {
    await folder.close();
  }
}
