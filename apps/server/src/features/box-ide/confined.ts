import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  lchown,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { BOX_RUN_AS, type BoxIdeEntry, isWorkspacePath } from "@opsifier/contract";

/**
 * Every file operation of the editor, confined to one workspace. A box can write its own symbolic links
 * there, so a path that looks fine can point at the panel's secrets. `/proc/self/fd` gives a directory
 * by what was opened rather than by name: each step of a path is opened from the one before it, none
 * of them through a link, and whatever happens to the path afterwards can't move an open directory.
 */

const USES_DIRECTORY_FDS = process.platform === "linux";

const OPEN_DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;
/** A file being written is never visible under its real name until it is whole. */
const TEMPORARY_PREFIX = ".opsifier-";
/** A runaway tree should end in an error, not in the panel running out of descriptors. */
const MAX_REMOVED_ENTRIES = 200_000;
const MAX_LISTED_ENTRIES = 5000;

export type WorkspaceRefusal =
  | "not_found"
  | "symlink"
  | "not_a_file"
  | "not_a_directory"
  | "exists"
  | "conflict"
  | "not_empty"
  | "invalid_path";

export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";

  constructor(
    readonly reason: WorkspaceRefusal,
    message: string,
  ) {
    super(message);
  }
}

const refuse = (reason: WorkspaceRefusal, message: string): WorkspaceError =>
  new WorkspaceError(reason, message);

function refusalFor(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case "ENOENT":
      return refuse("not_found", "Nothing is at this path.");
    case "ELOOP":
    case "EMLINK":
      return refuse("symlink", "This goes through a symbolic link, which the editor does not follow.");
    case "ENOTDIR":
      return refuse("not_a_directory", "Part of this path is not a folder.");
    case "EISDIR":
      return refuse("not_a_file", "This is a folder.");
    case "EEXIST":
      return refuse("exists", "Something already has this name.");
    case "ENOTEMPTY":
      return refuse("not_empty", "This folder is not empty.");
    case "EINVAL":
      return refuse("invalid_path", "This can't be done with that path.");
    default:
      return error;
  }
}

/** Nothing in a path is trusted here, however many checks it went through on its way in. */
function segmentsOf(path: string): string[] {
  if (path === "") {
    return [];
  }
  if (!isWorkspacePath(path)) {
    throw refuse("invalid_path", "This path is not inside the workspace.");
  }
  return path.split("/");
}

function splitParent(path: string): { parents: string[]; name: string } {
  const segments = segmentsOf(path);
  const name = segments.pop();
  if (name === undefined) {
    throw refuse("invalid_path", "The workspace itself can't be used here.");
  }
  return { parents: segments, name };
}

interface OpenDirectory {
  /** The directory itself. */
  readonly self: string;
  /** One entry of it, by name. A link at that name is the link, never where it points. */
  entry(name: string): string;
  close(): Promise<void>;
}

/**
 * Opens one step of a path as a directory. Linux reports a link here as "not a directory", because
 * of the combination of flags; the second look only chooses the words, and decides nothing.
 */
async function openStep(path: string): Promise<FileHandle> {
  try {
    return await open(path, OPEN_DIRECTORY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
      const stats = await lstat(path).catch(() => null);
      if (stats?.isSymbolicLink()) {
        throw refuse("symlink", "This goes through a symbolic link, which the editor does not follow.");
      }
    }
    throw refusalFor(error);
  }
}

const wrapDescriptor = (handle: FileHandle): OpenDirectory => ({
  self: `/proc/self/fd/${handle.fd}`,
  entry: (name) => `/proc/self/fd/${handle.fd}/${name}`,
  close: () => handle.close(),
});

async function openDescriptor(root: string, segments: readonly string[]): Promise<OpenDirectory> {
  let current = await openStep(root);
  try {
    for (const segment of segments) {
      const next = await openStep(`/proc/self/fd/${current.fd}/${segment}`);
      await current.close();
      current = next;
    }
    return wrapDescriptor(current);
  } catch (error) {
    await current.close();
    throw error;
  }
}

/** For development on a machine with no `/proc`. The check and the use are two steps apart here. */
async function openByPath(root: string, segments: readonly string[]): Promise<OpenDirectory> {
  let path = root;
  for (const segment of segments) {
    path = join(path, segment);
    const stats = await lstat(path).catch((error) => {
      throw refusalFor(error);
    });
    if (stats.isSymbolicLink()) {
      throw refuse("symlink", "This goes through a symbolic link, which the editor does not follow.");
    }
    if (!stats.isDirectory()) {
      throw refuse("not_a_directory", "Part of this path is not a folder.");
    }
  }
  return { self: path, entry: (name) => join(path, name), close: async () => {} };
}

const openDirectory = USES_DIRECTORY_FDS ? openDescriptor : openByPath;

async function withDirectory<T>(
  root: string,
  segments: readonly string[],
  use: (directory: OpenDirectory) => Promise<T>,
): Promise<T> {
  const directory = await openDirectory(root, segments);
  try {
    return await use(directory);
  } finally {
    await directory.close();
  }
}

const statOf = async (directory: OpenDirectory, name: string): Promise<Stats | null> =>
  lstat(directory.entry(name)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw refusalFor(error);
  });

/** The panel runs as root, and what it creates has to belong to the box's own user. */
async function handOver(path: string, uid: number, gid: number): Promise<void> {
  if (process.getuid?.() === 0) {
    await lchown(path, uid, gid);
  }
}

/** Changes with any edit, from any side, without reading the file. */
const versionOf = (stats: Stats): string => `${stats.ino}-${stats.size}-${stats.mtimeMs}`;

export interface WorkspaceFile {
  content: string | null;
  unreadable: "binary" | "too_large" | null;
  version: string;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

export async function listWorkspaceDirectory(
  root: string,
  path: string,
): Promise<{ entries: BoxIdeEntry[]; truncated: boolean }> {
  return withDirectory(root, segmentsOf(path), async (directory) => {
    const dirents = await readdir(directory.self, { withFileTypes: true }).catch((error) => {
      throw refusalFor(error);
    });
    const entries = dirents
      .filter((dirent) => !dirent.name.startsWith(TEMPORARY_PREFIX))
      .map(
        (dirent): BoxIdeEntry => ({
          name: dirent.name,
          kind: dirent.isDirectory()
            ? "directory"
            : dirent.isSymbolicLink()
              ? "symlink"
              : dirent.isFile()
                ? "file"
                : "other",
        }),
      )
      .sort(
        (a, b) =>
          Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name),
      );
    return {
      entries: entries.slice(0, MAX_LISTED_ENTRIES),
      truncated: entries.length > MAX_LISTED_ENTRIES,
    };
  });
}

export async function readWorkspaceFile(
  root: string,
  path: string,
  maxBytes: number,
): Promise<WorkspaceFile> {
  const { parents, name } = splitParent(path);
  return withDirectory(root, parents, async (directory) => {
    // Non-blocking, so that a named pipe someone left behind can't hold the request open.
    const handle = await open(
      directory.entry(name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error) => {
      throw refusalFor(error);
    });
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw refuse("not_a_file", "Only ordinary files can be opened.");
      }
      if (stats.size > maxBytes) {
        return { content: null, unreadable: "too_large", version: versionOf(stats) };
      }
      const content = decodeText(await handle.readFile());
      return {
        content,
        unreadable: content === null ? "binary" : null,
        version: versionOf(stats),
      };
    } finally {
      await handle.close();
    }
  });
}

async function writeNew(
  directory: OpenDirectory,
  temporary: string,
  content: string,
  mode: number,
): Promise<void> {
  const handle = await open(
    directory.entry(temporary),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Replaces a file, or creates one when `expected` is null, and answers with its new version. The new
 * content appears all at once, and a file that changed since it was read is left as it is.
 */
export async function writeWorkspaceFile(
  root: string,
  path: string,
  content: string,
  expected: string | null,
): Promise<string> {
  const { parents, name } = splitParent(path);
  return withDirectory(root, parents, async (directory) => {
    const current = await statOf(directory, name);
    if (current?.isSymbolicLink()) {
      throw refuse("symlink", "This is a symbolic link, which the editor does not follow.");
    }
    if (expected === null && current !== null) {
      throw refuse("exists", "Something already has this name.");
    }
    if (expected !== null) {
      if (current === null) {
        throw refuse("not_found", "This file is gone.");
      }
      if (!current.isFile()) {
        throw refuse("not_a_file", "Only ordinary files can be edited.");
      }
      if (versionOf(current) !== expected) {
        throw refuse("conflict", "This file changed since it was opened.");
      }
    }
    const temporary = `${TEMPORARY_PREFIX}${randomBytes(8).toString("hex")}.tmp`;
    await writeNew(directory, temporary, content, current?.mode ?? FILE_MODE).catch((error) => {
      throw refusalFor(error);
    });
    try {
      await handOver(
        directory.entry(temporary),
        current?.uid ?? BOX_RUN_AS.uid,
        current?.gid ?? BOX_RUN_AS.gid,
      );
      await rename(directory.entry(temporary), directory.entry(name));
    } catch (error) {
      await unlink(directory.entry(temporary)).catch(() => undefined);
      throw refusalFor(error);
    }
    const written = await statOf(directory, name);
    return written === null ? "" : versionOf(written);
  });
}

export async function createWorkspaceDirectory(root: string, path: string): Promise<void> {
  const { parents, name } = splitParent(path);
  return withDirectory(root, parents, async (directory) => {
    await mkdir(directory.entry(name), { mode: DIRECTORY_MODE }).catch((error) => {
      throw refusalFor(error);
    });
    await handOver(directory.entry(name), BOX_RUN_AS.uid, BOX_RUN_AS.gid);
  });
}

export async function moveWorkspaceEntry(root: string, from: string, to: string): Promise<void> {
  const source = splitParent(from);
  const destination = splitParent(to);
  return withDirectory(root, source.parents, (origin) =>
    withDirectory(root, destination.parents, async (target) => {
      if ((await statOf(origin, source.name)) === null) {
        throw refuse("not_found", "Nothing is at this path.");
      }
      if ((await statOf(target, destination.name)) !== null) {
        throw refuse("exists", "Something already has this name.");
      }
      await rename(origin.entry(source.name), target.entry(destination.name)).catch((error) => {
        throw refusalFor(error);
      });
    }),
  );
}

/** Removes a tree without following anything in it: a link is unlinked, and what it points at stays. */
async function removeTree(directory: OpenDirectory, name: string, budget: { left: number }): Promise<void> {
  budget.left -= 1;
  if (budget.left < 0) {
    throw new Error("This folder holds too many files to remove at once.");
  }
  const stats = await lstat(directory.entry(name));
  if (!stats.isDirectory()) {
    await unlink(directory.entry(name));
    return;
  }
  const inner = USES_DIRECTORY_FDS
    ? wrapDescriptor(await openStep(directory.entry(name)))
    : await openByPath(directory.entry(name), []);
  try {
    for (const entry of await readdir(inner.self)) {
      await removeTree(inner, entry, budget);
    }
  } finally {
    await inner.close();
  }
  await rmdir(directory.entry(name));
}

export async function removeWorkspaceEntry(root: string, path: string, recursive: boolean): Promise<void> {
  const { parents, name } = splitParent(path);
  return withDirectory(root, parents, async (directory) => {
    const stats = await statOf(directory, name);
    if (stats === null) {
      throw refuse("not_found", "Nothing is at this path.");
    }
    if (!stats.isDirectory()) {
      await unlink(directory.entry(name)).catch((error) => {
        throw refusalFor(error);
      });
      return;
    }
    if (recursive) {
      await removeTree(directory, name, { left: MAX_REMOVED_ENTRIES }).catch((error) => {
        throw refusalFor(error);
      });
    } else {
      await rmdir(directory.entry(name)).catch((error) => {
        throw refusalFor(error);
      });
    }
  });
}

/**
 * Adds files only where nothing has that name, creating their folders as needed. Says how many it
 * added. Whatever is already in a workspace, including a link or a folder of that name, stays.
 */
export async function seedWorkspaceFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<number> {
  let added = 0;
  for (const [path, content] of Object.entries(files)) {
    const { parents, name } = splitParent(path);
    if (!(await ensureFolders(root, parents))) {
      continue;
    }
    await withDirectory(root, parents, async (directory) => {
      if ((await statOf(directory, name)) !== null) {
        return;
      }
      try {
        await writeNew(directory, name, content, FILE_MODE);
      } catch (error) {
        // Something took the name since it was looked at. Whatever it is, it stays.
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return;
        }
        throw error;
      }
      await handOver(directory.entry(name), BOX_RUN_AS.uid, BOX_RUN_AS.gid);
      added += 1;
    });
  }
  return added;
}

/** Creates what is missing of a folder path. False when something else already sits on the way. */
async function ensureFolders(root: string, segments: readonly string[]): Promise<boolean> {
  for (let depth = 0; depth < segments.length; depth += 1) {
    const name = segments[depth] as string;
    const present = await withDirectory(root, segments.slice(0, depth), async (directory) => {
      const stats = await statOf(directory, name);
      if (stats === null) {
        await mkdir(directory.entry(name), { mode: DIRECTORY_MODE });
        await handOver(directory.entry(name), BOX_RUN_AS.uid, BOX_RUN_AS.gid);
        return true;
      }
      return stats.isDirectory();
    });
    if (!present) {
      return false;
    }
  }
  return true;
}
