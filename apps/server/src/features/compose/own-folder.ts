import { lstat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import type { ComposeIssue } from "@opsifier/contract";

/**
 * A stack's containers write its folder through their relative mounts, and Docker resolves a mount's
 * source again, links and all, every time it starts a container; Compose reads the stack's files again
 * when it starts it, and a build reads what it builds from, following links, while the containers still
 * run. So no container may be able to write a folder's entry that a mount's source goes through, nor
 * the files the stack is read from, nor anything a build reads or writes: otherwise one child replaces
 * a folder another child mounts with a link to anywhere on the server, has a build read the panel's
 * secrets into an image, or rewrites the file between the check and the start.
 *
 * A child can only write inside what it mounts, never the entry of the folder it mounts. That holds as
 * long as no mount is the stack's own folder, none holds another mount, none holds a file the stack is
 * read from, and mounts and what builds use never hold one another. Two children may share one folder:
 * neither can replace it.
 */

/** A folder or file of the stack a child mounts, as a path from the stack's folder: `.` is the folder. */
export interface StackMount {
  service: string | null;
  path: string;
}

/** Something a build reads or writes on the panel's side, as a path from the stack's folder. */
export interface BuildInput extends StackMount {
  /** Which part of the build names it, as Compose calls it: `context`, `dockerfile`, `cache_to`… */
  field: string;
  /** Whether the build writes there: a local cache it exports. */
  written: boolean;
}

/**
 * A path as seen from the stack's folder, once `..` has been followed: `.` for the folder itself, and
 * no `./` or trailing slash otherwise. Null for one that leaves the folder, which is refused elsewhere.
 */
export function stackRelative(path: string, base = "."): string | null {
  const normal = posix.normalize(posix.join(base, path)).replace(/\/+$/, "") || ".";
  return normal === ".." || normal.startsWith("../") || normal.startsWith("/") ? null : normal;
}

/**
 * Whether a path from a folder, as `relative` gives it, leaves that folder. A name that merely starts
 * with two dots, `..data`, is inside it.
 */
export const leaves = (inside: string): boolean =>
  inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);

/** An absolute path inside the stack's folder, as `stackRelative` writes it. Null for one outside. */
export function fromStackFolder(root: string, path: string): string | null {
  const inside = relative(root, path);
  if (leaves(inside)) {
    return null;
  }
  return inside === "" ? "." : inside.split(sep).join(posix.sep);
}

const holds = (folder: string, path: string): boolean => folder === "." || path.startsWith(`${folder}/`);

/**
 * A local cache a build imports or exports. BuildKit opens its files by path, following links, unlike
 * a context, which it copies with its links as links.
 */
export const isBuildCache = (input: Pick<BuildInput, "field">): boolean =>
  input.field === "cache_from" || input.field === "cache_to";

const shown = (path: string): string => (path === "." ? "." : `./${path}`);

/**
 * Every mount no container may have: the stack's own folder, a folder that holds another mount, a
 * folder or file that holds a file the stack is read from, and one that holds what a build uses. And
 * every local cache a build reads or writes where a container can plant a link: one that holds a
 * mount, and one it writes that holds the stack's files. A folder a build only copies may hold a
 * mount, `build: .` beside `./data` the common case: a link a container leaves inside it is copied as
 * a link, never followed. Its detail names the mount, or the part of the build, then what it holds.
 */
export function ownFolderIssues(
  mounts: readonly StackMount[],
  files: readonly string[],
  inputs: readonly BuildInput[] = [],
): ComposeIssue[] {
  const found = new Map<string, ComposeIssue>();
  const add = (service: string | null, detail: string) =>
    found.set(`${service}|${detail}`, { severity: "error", code: "mounts_stack", service, detail });
  for (const mount of mounts) {
    if (mount.path === ".") {
      add(mount.service, ".");
      continue;
    }
    for (const other of mounts) {
      if (other.path !== mount.path && holds(mount.path, other.path)) {
        add(mount.service, `${shown(mount.path)} (holds ${shown(other.path)})`);
      }
    }
    for (const file of files) {
      if (file === mount.path) {
        add(mount.service, shown(file));
      } else if (holds(mount.path, file)) {
        add(mount.service, `${shown(mount.path)} (holds ${shown(file)})`);
      }
    }
    for (const input of inputs) {
      if (input.path === mount.path) {
        add(mount.service, `${shown(mount.path)} (is the ${input.field} of ${input.service ?? "a build"})`);
      } else if (holds(mount.path, input.path)) {
        add(mount.service, `${shown(mount.path)} (holds the ${input.field} ${shown(input.path)})`);
      }
    }
  }
  for (const input of inputs) {
    // A cache is opened through any link a container plants in what it holds; one written could also
    // go over the stack's files. A context is only copied.
    if (!isBuildCache(input)) {
      continue;
    }
    const held = [...mounts.map((mount) => mount.path), ...(input.written ? files : [])].filter(
      (path) => (input.written && path === input.path) || (path !== input.path && holds(input.path, path)),
    );
    for (const path of held) {
      add(input.service, `${input.field}: ${shown(input.path)} (holds ${shown(path)})`);
    }
  }
  return [...found.values()];
}

/** A bind of a container of the stack that is running, as Docker reports it. */
export interface RunningBind {
  child: string;
  container: string;
  /** The host path it mounts. */
  source: string;
  /** Whether the container may write there. Taken as so when Docker doesn't say. */
  rw?: boolean;
}

/** What one of those holds of the stack as it is about to start, both from the stack's code folder. */
export interface HeldByRunning extends RunningBind {
  path: string;
  holds: string;
  /**
   * Whether the bind is inside what a build reads, rather than holding something: a local cache, or a
   * context that would walk it.
   */
  insideBuild: boolean;
  /** For a bind inside a context, the bind from the context, which its ignore file could leave out. */
  fromContext?: string;
}

/**
 * The containers of the stack's last deploy keep running while Compose pulls and builds the new one,
 * and are only replaced after that, so the new configuration's rules hold for them too: none may mount
 * a folder that holds one of its mounts, nor a folder or file that holds a file it is read from or
 * what its builds use, nor sit inside a local cache a build uses, nor write inside a context a build
 * walks, unless the context's ignore file leaves that folder out. Their binds were judged against the
 * files of their own time, not these. A bind outside the stack's code folder is host access someone
 * confirmed, and reaches farther than this could tell.
 */
export function heldByRunning(
  root: string,
  running: readonly RunningBind[],
  guarded: {
    mounts: readonly string[];
    files: readonly string[];
    inputs?: readonly string[];
    /** The local caches builds read or write, among those inputs. */
    caches?: readonly string[];
    /** The contexts builds walk, with the folders of each, from it, that they never walk. */
    contexts?: readonly { path: string; excluded: readonly string[] }[];
  },
): HeldByRunning | null {
  const inside = (paths: readonly string[]) =>
    paths.flatMap((path) => {
      const relative = fromStackFolder(root, posix.normalize(path));
      return relative === null ? [] : [relative];
    });
  const mounts = inside(guarded.mounts);
  const files = inside(guarded.files);
  const inputs = inside(guarded.inputs ?? []);
  const caches = inside(guarded.caches ?? []);
  const contexts = (guarded.contexts ?? []).flatMap(({ path, excluded }) => {
    const relative = fromStackFolder(root, posix.normalize(path));
    return relative === null ? [] : [{ path: relative, excluded }];
  });
  for (const bind of running) {
    const path = fromStackFolder(root, posix.normalize(bind.source).replace(/(.)\/+$/, "$1"));
    if (path === null) {
      continue;
    }
    const held =
      mounts.find((mount) => mount !== path && holds(path, mount)) ??
      [...files, ...inputs].find((file) => file === path || holds(path, file));
    if (held !== undefined) {
      return { ...bind, path, holds: held, insideBuild: false };
    }
    const cache = caches.find((input) => holds(input, path));
    if (cache !== undefined) {
      return { ...bind, path, holds: cache, insideBuild: true };
    }
    // A read-only bind can't change what the build reads; a read-write one can, unless it is left out.
    for (const context of bind.rw === false ? [] : contexts) {
      if (path !== context.path && holds(context.path, path)) {
        const fromContext = context.path === "." ? path : path.slice(context.path.length + 1);
        if (
          !context.excluded.some((folder) => fromContext === folder || fromContext.startsWith(`${folder}/`))
        ) {
          return { ...bind, path, holds: context.path, insideBuild: true, fromContext };
        }
      }
    }
  }
  return null;
}

/** Where a mount's source stops being a plain folder or file of the stack. */
export interface LinkedMount {
  service: string | null;
  /** The mount's source, from the stack's folder. */
  path: string;
  /** The first part of it that is not what it should be, from the stack's folder. */
  at: string;
  /** A link, a file where a folder should be, or something that is neither a folder nor a file. */
  kind: "link" | "not_a_folder" | "special";
  /** For what a build uses, which part of the build names it. */
  field?: string;
}

/**
 * Walks each mount's source from the stack's code folder down, without following anything: every part
 * on the way has to be a real folder, and the last a real folder or file. What does not exist yet is
 * left to Docker, which creates the folders: nothing a container can write leads there.
 */
export async function linkedMount(
  root: string,
  mounts: readonly { service: string | null; path: string; field?: string }[],
): Promise<LinkedMount | null> {
  for (const { service, path, field } of mounts) {
    const inside = relative(root, path);
    if (inside === "" || leaves(inside)) {
      continue;
    }
    const parts = inside.split(sep);
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stats = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      });
      if (stats === null) {
        break;
      }
      const at = parts.slice(0, index + 1).join(posix.sep);
      const last = index === parts.length - 1;
      const kind = stats.isSymbolicLink()
        ? "link"
        : stats.isDirectory()
          ? null
          : !last
            ? "not_a_folder"
            : stats.isFile()
              ? null
              : "special";
      if (kind !== null) {
        return {
          service,
          path: inside.split(sep).join(posix.sep),
          at,
          kind,
          ...(field === undefined ? {} : { field }),
        };
      }
    }
  }
  return null;
}
