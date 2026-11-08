import { lstat, mkdir, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AppDeps } from "../../../../core/context";
import { ToolTimeoutError } from "../../../../core/tools";
import { inheritedEnv } from "./environment";
import { isInside } from "./paths";

const LIST_TIMEOUT_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 15 * 60_000;
const SIZE_CHECK_INTERVAL_MS = 1500;

/** The limits on what an archive may unpack to, however small it was to upload. */
export const MAX_UNPACKED_BYTES = 10 * 1024 ** 3;
export const MAX_UNPACKED_ENTRIES = 500_000;

/** An archive the panel refuses to unpack. The message is safe to show. */
export class UnsafeArchiveError extends Error {
  override readonly name = "UnsafeArchiveError";
}

/** A name that would land outside the destination, in either kind of path separator. */
export function isUnsafeEntryName(name: string): boolean {
  const segments = name.replaceAll("\\", "/").split("/");
  return name.startsWith("/") || /^[A-Za-z]:/.test(name) || segments.includes("..");
}

export interface UnpackOptions {
  signal?: AbortSignal;
  maxBytes?: number;
}

const env = () => inheritedEnv();

/**
 * Lists an archive and refuses it if any entry could escape. `bsdtar` reads every format on the list,
 * so there is one implementation of all this to get right, not one per format.
 */
export async function inspectArchive(
  deps: Pick<AppDeps, "tools">,
  file: string,
  options: Pick<UnpackOptions, "signal"> = {},
): Promise<void> {
  const unsafe: string[] = [];
  let result: Awaited<ReturnType<AppDeps["tools"]["run"]>>;
  try {
    result = await deps.tools.run({
      command: "bsdtar",
      args: ["-tf", file],
      env: env(),
      signal: options.signal,
      timeoutMs: LIST_TIMEOUT_MS,
      onLine: (line) => {
        if (isUnsafeEntryName(line)) {
          unsafe.push(line);
        }
      },
    });
  } catch (error) {
    // Too slow to list at upload time is not a reason to refuse: unpacking checks it again.
    if (error instanceof ToolTimeoutError) {
      return;
    }
    throw error;
  }
  if (result.exitCode !== 0) {
    throw new UnsafeArchiveError("This is not an archive the panel can read.");
  }
  if (unsafe.length > 0) {
    throw new UnsafeArchiveError(
      `This archive has entries that would escape its folder, such as ${unsafe[0]}.`,
    );
  }
}

/** Measures what was unpacked, and fails on anything that isn't a plain file, folder or safe link. */
export async function verifyTree(root: string): Promise<{ bytes: number; entries: number }> {
  const realRoot = await realpath(root);
  let bytes = 0;
  let entries = 0;
  const pending = [realRoot];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) {
      break;
    }
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      entries += 1;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        bytes += (await lstat(path)).size;
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        if (!isInside(realRoot, resolve(dirname(path), target))) {
          throw new UnsafeArchiveError(`This archive has a link pointing outside its folder: ${entry.name}.`);
        }
      } else {
        throw new UnsafeArchiveError(
          `This archive has a special file the panel will not create: ${entry.name}.`,
        );
      }
    }
  }
  return { bytes, entries };
}

function tooLarge(bytes: number, entries: number, maxBytes: number): boolean {
  return bytes > maxBytes || entries > MAX_UNPACKED_ENTRIES;
}

/** Unpacks into `destination`, which must be empty, watching the size so a decompression bomb stops early. */
export async function unpackArchive(
  deps: Pick<AppDeps, "tools">,
  file: string,
  destination: string,
  options: UnpackOptions = {},
): Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_UNPACKED_BYTES;
  await mkdir(destination, { recursive: true });
  await inspectArchive(deps, file, options);

  const controller = new AbortController();
  const signal =
    options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]);
  let exceeded = false;
  let checking = false;
  const watcher = setInterval(() => {
    if (checking) {
      return;
    }
    checking = true;
    measure(destination)
      .then(({ bytes, entries }) => {
        if (tooLarge(bytes, entries, maxBytes)) {
          exceeded = true;
          controller.abort(new UnsafeArchiveError("This archive unpacks to more than the panel allows."));
        }
      })
      // The tree is changing under the walk: the next round sees a consistent one.
      .catch(() => undefined)
      .finally(() => {
        checking = false;
      });
  }, SIZE_CHECK_INTERVAL_MS);
  watcher.unref();

  try {
    const result = await deps.tools.run({
      command: "bsdtar",
      // No `-P`: bsdtar then refuses `..` and anything reached through a symlink it just created.
      // Ownership and special bits from a stranger's archive are not applied.
      args: [
        "-xf",
        file,
        "-C",
        destination,
        "--no-same-owner",
        "--no-same-permissions",
        "--no-acls",
        "--no-fflags",
        "--no-xattrs",
      ],
      env: env(),
      signal,
      timeoutMs: EXTRACT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new UnsafeArchiveError(
        `The archive could not be unpacked: ${result.tail.slice(-1)[0] ?? "unknown error"}`,
      );
    }
  } catch (error) {
    if (exceeded) {
      throw new UnsafeArchiveError("This archive unpacks to more than the panel allows.");
    }
    throw error;
  } finally {
    clearInterval(watcher);
  }

  const { bytes, entries } = await verifyTree(destination);
  if (tooLarge(bytes, entries, maxBytes)) {
    throw new UnsafeArchiveError("This archive unpacks to more than the panel allows.");
  }
}

/** Tolerant version of the final check, for use while files are still appearing. */
async function measure(root: string): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) {
      break;
    }
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      entries += 1;
      if (entry.isDirectory()) {
        pending.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        bytes += (await lstat(join(dir, entry.name)).catch(() => ({ size: 0 }))).size;
      }
    }
  }
  return { bytes, entries };
}

/**
 * An archive made by zipping a folder has one top-level folder, which GitHub's own downloads do too:
 * the source is what's inside it. Returns the directory to use as the source root.
 */
export async function unwrapSingleFolder(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const only = entries[0];
  return entries.length === 1 && only?.isDirectory() ? join(root, only.name) : root;
}
