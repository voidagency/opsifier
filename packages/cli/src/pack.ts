import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { ClientError } from "@opsifier/client";

/**
 * Packs a folder into a gzipped tar the panel can build from, leaving out what git would leave out:
 * every `.gitignore` from the repository's root down, `.git/info/exclude` and the user's global
 * excludes file, then `.opsifierignore`, which comes after `.gitignore` in each folder. The command
 * line runs no other program, git included, so it reads them itself.
 */

/** Always left out: the repository's own history, and the folder's link to its service. */
const ALWAYS_LEFT_OUT = new Set([".git", ".opsifier.json"]);
const IGNORE_FILES = [".gitignore", ".opsifierignore"];

interface IgnoreRule {
  /** The folder the rule was written in, relative to the root, "" for the root itself. */
  base: string;
  negate: boolean;
  directoryOnly: boolean;
  pattern: RegExp;
}

function escapeForRegex(char: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char;
}

/** A glob as git reads it in an ignore file, as the body of a regular expression. */
function globBody(glob: string): string {
  let out = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        const before = index === 0 || glob[index - 1] === "/";
        const after = index + 2 === glob.length || glob[index + 2] === "/";
        if (before && after) {
          if (index + 2 === glob.length) {
            out += ".*";
          } else {
            // `**/`: any number of folders, none included.
            out += "(?:.*/)?";
            index += 1;
          }
          index += 1;
          continue;
        }
      }
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "[") {
      const end = glob.indexOf("]", index + 2);
      if (end === -1) {
        out += "\\[";
        continue;
      }
      let inner = glob.slice(index + 1, end);
      if (inner.startsWith("!")) {
        inner = `^${inner.slice(1)}`;
      }
      out += `[${inner.replace(/\\/g, "\\\\")}]`;
      index = end;
    } else if (char === "\\" && index + 1 < glob.length) {
      index += 1;
      out += escapeForRegex(glob[index] as string);
    } else {
      out += escapeForRegex(char);
    }
  }
  return out;
}

export function compileIgnoreLine(line: string, base: string): IgnoreRule | undefined {
  let glob = line.replace(/\r$/, "");
  if (glob.trim() === "" || glob.startsWith("#")) {
    return undefined;
  }
  glob = glob.replace(/(?<!\\)\s+$/, "");
  let negate = false;
  if (glob.startsWith("!")) {
    negate = true;
    glob = glob.slice(1);
  } else if (glob.startsWith("\\!") || glob.startsWith("\\#")) {
    glob = glob.slice(1);
  }
  let directoryOnly = false;
  if (glob.endsWith("/")) {
    directoryOnly = true;
    glob = glob.slice(0, -1);
  }
  if (glob === "") {
    return undefined;
  }
  // A slash anywhere but at the end ties the pattern to the folder of its ignore file.
  const anchored = glob.includes("/");
  if (glob.startsWith("/")) {
    glob = glob.slice(1);
  }
  const body = globBody(glob);
  let pattern: RegExp;
  try {
    pattern = new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
  } catch {
    // A pattern git can't match either, such as the range [z-a]: it leaves nothing out.
    return undefined;
  }
  return { base, negate, directoryOnly, pattern };
}

/** The last rule that matches decides, the deepest ignore files coming last, as in git. */
export function isIgnored(rules: readonly IgnoreRule[], path: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) {
      continue;
    }
    let inside: string;
    if (rule.base === "") {
      inside = path;
    } else if (path.startsWith(`${rule.base}/`)) {
      inside = path.slice(rule.base.length + 1);
    } else {
      continue;
    }
    if (rule.pattern.test(inside)) {
      ignored = !rule.negate;
    }
  }
  return ignored;
}

async function readIfThere(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    // An ignore file that can't be read can't be honoured: better to stop than to send too much.
    throw error;
  }
}

async function rulesFrom(file: string, base: string): Promise<IgnoreRule[]> {
  const text = await readIfThere(file);
  if (text === undefined) {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const line of text.replace(/^\uFEFF/, "").split("\n")) {
    const rule = compileIgnoreLine(line, base);
    if (rule !== undefined) {
      rules.push(rule);
    }
  }
  return rules;
}

async function rulesIn(folder: string, base: string): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  for (const name of IGNORE_FILES) {
    rules.push(...(await rulesFrom(join(folder, name), base)));
  }
  return rules;
}

/** The folder that holds `.git`, from `start` up, or undefined outside a repository. */
async function repositoryRoot(start: string): Promise<string | undefined> {
  let folder = start;
  for (;;) {
    try {
      await lstat(join(folder, ".git"));
      return folder;
    } catch {
      const parent = dirname(folder);
      if (parent === folder) {
        return undefined;
      }
      folder = parent;
    }
  }
}

/** git's `core.excludesFile`, from the user's own configuration, else its default place. */
async function globalExcludesFile(env: Record<string, string | undefined>): Promise<string> {
  const home = env.HOME?.trim() || homedir();
  const config = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  let found: string | undefined;
  // Read in git's order, so that ~/.gitconfig has the last word.
  for (const file of [join(config, "git", "config"), join(home, ".gitconfig")]) {
    const text = await readIfThere(file).catch(() => undefined);
    let section = "";
    for (const raw of text?.split("\n") ?? []) {
      const line = raw.trim();
      const header = /^\[\s*([^\s\]"]+)/.exec(line);
      if (header !== null) {
        section = (header[1] as string).toLowerCase();
        continue;
      }
      const entry = /^excludesfile\s*=\s*(.+)$/i.exec(line);
      if (section === "core" && entry !== null) {
        const value = (entry[1] as string).replace(/^"(.*)"$/, "$1").trim();
        found = value.startsWith("~/") ? join(home, value.slice(2)) : value;
      }
    }
  }
  return found ?? join(config, "git", "ignore");
}

// ---- tar (POSIX ustar, with pax records for long or non-ASCII names) ----

const BLOCK = 512;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  // The length counts its own digits: settle it once their number stops changing.
  while (String(length).length + Buffer.byteLength(body) !== length) {
    length = String(length).length + Buffer.byteLength(body);
  }
  return Buffer.from(`${length}${body}`, "utf8");
}

function padded(data: Buffer): Buffer[] {
  const rest = data.length % BLOCK;
  return rest === 0 ? [data] : [data, Buffer.alloc(BLOCK - rest)];
}

interface EntryHeader {
  name: string;
  type: "0" | "2" | "5" | "x";
  mode: number;
  size: number;
  mtime: number;
  linkname?: string;
}

/** Fits in ustar's own fields: short enough, and plain ASCII. */
const fitsUstar = (value: string, bytes: number) =>
  /^[\x20-\x7e]*$/.test(value) && Buffer.byteLength(value) <= bytes;

function headerBlock(entry: EntryHeader): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(entry.name, 0, 100, "utf8");
  block.write(octal(entry.mode, 8), 100, 8, "ascii");
  block.write(octal(0, 8), 108, 8, "ascii");
  block.write(octal(0, 8), 116, 8, "ascii");
  block.write(octal(entry.size, 12), 124, 12, "ascii");
  block.write(octal(entry.mtime, 12), 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");
  block.write(entry.type, 156, 1, "ascii");
  block.write(entry.linkname ?? "", 157, 100, "utf8");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function entryBlocks(entry: EntryHeader, data?: Buffer): Buffer[] {
  const blocks: Buffer[] = [];
  const records: Buffer[] = [];
  if (!fitsUstar(entry.name, 100)) {
    records.push(paxRecord("path", entry.name));
  }
  if (entry.linkname !== undefined && !fitsUstar(entry.linkname, 100)) {
    records.push(paxRecord("linkpath", entry.linkname));
  }
  if (records.length > 0) {
    const pax = Buffer.concat(records);
    blocks.push(
      headerBlock({ name: "PaxHeader", type: "x", mode: 0o644, size: pax.length, mtime: entry.mtime }),
      ...padded(pax),
    );
  }
  const shortName = fitsUstar(entry.name, 100)
    ? entry.name
    : entry.name.slice(-100).replace(/[^\x20-\x7e]/g, "_");
  const shortLink =
    entry.linkname === undefined || fitsUstar(entry.linkname, 100) ? entry.linkname : "PaxLinkTarget";
  blocks.push(headerBlock({ ...entry, name: shortName, linkname: shortLink }));
  if (data !== undefined && data.length > 0) {
    blocks.push(...padded(data));
  }
  return blocks;
}

export interface Packed {
  archive: Buffer;
  /** Regular files packed. */
  files: number;
  /** Their size, before compression. */
  bytes: number;
  /** What could not go in: special files, and links that lead out of the folder. */
  skipped: string[];
  /** Files whose name says they may hold secrets, packed because nothing ignores them. */
  secrets: string[];
}

/** Names that usually hold secrets. Templates such as `.env.example` are meant to be shared. */
const SECRET_NAME =
  /^\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?$|\.(pem|key|p12|pfx|jks|keystore|kdbx)$|^id_(rsa|dsa|ecdsa|ed25519)$|^\.(netrc|npmrc|pypirc|envrc|pgpass|htpasswd)$|^credentials[^/]*\.json$|^kubeconfig$|^secrets?\.(json|ya?ml|toml|env)$/;
/** Folders and files that hold a machine's own credentials, wherever they are. */
const SECRET_PATH = /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube)\/|(^|\/)\.docker\/config\.json$/;

export function looksSecret(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return SECRET_NAME.test(name) || SECRET_PATH.test(path);
}

export interface PackOptions {
  signal?: AbortSignal;
  /** Absolute paths never packed, wherever they are: the command line's own key file, for one. */
  exclude?: readonly string[];
  /** Where git's own configuration is looked for: HOME and XDG_CONFIG_HOME. */
  env?: Record<string, string | undefined>;
}

const toPosix = (path: string) => path.split(sep).join("/");

export async function packFolder(root: string, options: PackOptions = {}): Promise<Packed> {
  const top = resolve(root);
  const excluded = new Set((options.exclude ?? []).map((path) => resolve(path)));
  const blocks: Buffer[] = [];
  const skipped: string[] = [];
  const secrets: string[] = [];
  let files = 0;
  let bytes = 0;

  // Rules are matched against paths from the repository's root, as git matches them.
  const repository = await repositoryRoot(top);
  const prefix = repository === undefined ? "" : toPosix(relative(repository, top));
  const fromRoot = (path: string) => (prefix === "" ? path : path === "" ? prefix : `${prefix}/${path}`);
  const inherited = await rulesFrom(await globalExcludesFile(options.env ?? process.env), "");
  if (repository !== undefined) {
    inherited.push(...(await rulesFrom(join(repository, ".git", "info", "exclude"), "")));
    const parts = prefix === "" ? [] : prefix.split("/");
    for (let depth = 0; depth < parts.length; depth += 1) {
      inherited.push(
        ...(await rulesIn(join(repository, ...parts.slice(0, depth)), parts.slice(0, depth).join("/"))),
      );
    }
  }

  async function walk(folder: string, rules: IgnoreRule[]): Promise<void> {
    const here = toPosix(relative(top, folder));
    const local = [...rules, ...(await rulesIn(folder, fromRoot(here)))];
    const names = (await readdir(folder)).sort();
    for (const name of names) {
      if (options.signal?.aborted) {
        throw new ClientError("cancelled", "Interrupted.");
      }
      const absolute = join(folder, name);
      const path = here === "" ? name : `${here}/${name}`;
      if (ALWAYS_LEFT_OUT.has(name) || excluded.has(absolute)) {
        continue;
      }
      const info = await lstat(absolute);
      if (isIgnored(local, fromRoot(path), info.isDirectory())) {
        continue;
      }
      const mtime = Math.floor(info.mtimeMs / 1000);
      if (info.isSymbolicLink()) {
        const target = await readlink(absolute);
        const lands = resolve(dirname(absolute), target);
        // The panel refuses a link that leads out of the folder when it unpacks: better said here.
        if (lands !== top && !lands.startsWith(`${top}${sep}`)) {
          skipped.push(path);
          continue;
        }
        // An absolute target names this machine's folders: the same place, written from the link.
        const linkname = isAbsolute(target) ? toPosix(relative(dirname(absolute), lands)) || "." : target;
        blocks.push(...entryBlocks({ name: path, type: "2", mode: 0o777, size: 0, mtime, linkname }));
      } else if (info.isDirectory()) {
        blocks.push(...entryBlocks({ name: `${path}/`, type: "5", mode: 0o755, size: 0, mtime }));
        await walk(absolute, local);
      } else if (info.isFile()) {
        const data = await readFile(absolute);
        const executable = (info.mode & 0o111) !== 0;
        blocks.push(
          ...entryBlocks(
            { name: path, type: "0", mode: executable ? 0o755 : 0o644, size: data.length, mtime },
            data,
          ),
        );
        files += 1;
        bytes += data.length;
        if (looksSecret(fromRoot(path))) {
          secrets.push(path);
        }
      } else {
        skipped.push(path);
      }
    }
  }

  await walk(top, inherited);
  blocks.push(Buffer.alloc(BLOCK * 2));
  const archive = await promisify(gzip)(Buffer.concat(blocks));
  return { archive, files, bytes, skipped, secrets };
}
