import { randomBytes } from "node:crypto";
import {
  MAX_STUDIO_ATTACHMENT_BYTES,
  STUDIO_ATTACHMENT_TYPES,
  type StudioAttachment,
  type StudioAttachmentExtension,
} from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { DockerDriverError } from "../../core/docker";
import { AppError, badRequest, conflict, serviceUnavailable } from "../../core/errors";
import { runInDatabase } from "../databases/exec";
import { qualifiedName } from "../services/compile";

/**
 * Files a person attaches to a message besides images: PDF, Word, Excel, PowerPoint, CSV or text. The
 * panel writes each in the project's folder, under `.git/opsifier-attachments/<random>/`, from inside the
 * agent server's container: git never tracks what is inside `.git`, so the agent cannot push it by
 * accident, and the random folder name keeps the preview's visitors from finding it. The message then
 * tells the agent where the file is.
 */

/** Where the files go, from the project's folder. */
export const ATTACHMENTS_DIR = ".git/opsifier-attachments";
/** What a project's attached files may take in all: the next one is refused past it. */
export const MAX_ATTACHMENTS_BYTES = 100 * 1024 * 1024;
const ATTACH_PREFIX = "opsifier-studio-attach ";
const ATTACH_TIMEOUT_MS = 60_000;
/** A name is cut to this many characters, its ending kept, and to this many bytes in all. */
const MAX_STEM_CHARS = 100;
const MAX_NAME_BYTES = 200;
/** A file that stops arriving for this long is given up. */
const IDLE_MS = 30_000;
/** Files saved at once, for the whole panel and for one person: each is held in memory while it is. */
const MAX_AT_ONCE = 6;
const MAX_AT_ONCE_PER_PERSON = 2;

/**
 * Runs in the agent server's container, with the project's folder, the new folder's name, the file's
 * name and the quota as arguments and the file's bytes as input. Each folder is opened from the one
 * above it without following a link, so nothing swapped in on the way can send the file elsewhere. The
 * file goes in a new folder of its own and belongs to the owner of the project's folder, whom the agent
 * runs as. On any failure, what this run made is taken back.
 */
export const ATTACH_SCRIPT = `
import json, os, sys
def done(result):
    print(${JSON.stringify(ATTACH_PREFIX)} + json.dumps(result))
    sys.exit(0)
root, folder, name, quota = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
data = sys.stdin.buffer.read()
DIRECTORY = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
def chown(fd, owner):
    try:
        os.fchown(fd, owner.st_uid, owner.st_gid)
    except OSError:
        pass
base_fd = None
made = False
try:
    root_fd = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    owner = os.fstat(root_fd)
    try:
        git_fd = os.open(".git", DIRECTORY, dir_fd=root_fd)
    except OSError:
        done({"ok": False, "code": "no_git"})
    try:
        os.mkdir("opsifier-attachments", 0o755, dir_fd=git_fd)
        fresh = True
    except FileExistsError:
        fresh = False
    try:
        base_fd = os.open("opsifier-attachments", DIRECTORY, dir_fd=git_fd)
    except OSError:
        done({"ok": False, "code": "unsafe"})
    if fresh:
        chown(base_fd, owner)
    used = 0
    for entry in os.scandir(base_fd):
        if not entry.is_dir(follow_symlinks=False):
            continue
        try:
            inner = os.open(entry.name, DIRECTORY, dir_fd=base_fd)
        except OSError:
            continue
        try:
            for item in os.scandir(inner):
                if item.is_file(follow_symlinks=False):
                    used += item.stat(follow_symlinks=False).st_size
        finally:
            os.close(inner)
    if used + len(data) > quota:
        done({"ok": False, "code": "full"})
    os.mkdir(folder, 0o755, dir_fd=base_fd)
    made = True
    folder_fd = os.open(folder, DIRECTORY, dir_fd=base_fd)
    chown(folder_fd, owner)
    handle = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644, dir_fd=folder_fd)
    with os.fdopen(handle, "wb") as out:
        chown(out.fileno(), owner)
        out.write(data)
except SystemExit:
    raise
except Exception as error:
    if made and base_fd is not None:
        try:
            inner = os.open(folder, DIRECTORY, dir_fd=base_fd)
            for item in os.scandir(inner):
                os.unlink(item.name, dir_fd=inner)
            os.close(inner)
            os.rmdir(folder, dir_fd=base_fd)
        except OSError:
            pass
    done({"ok": False, "code": "write", "message": str(error)[:300]})
done({"ok": True})
`;

const typeRefused = (message: string) => badRequest("studio_attachment_type", message, { name: message });

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

const isKnownExtension = (extension: string): extension is StudioAttachmentExtension =>
  Object.hasOwn(STUDIO_ATTACHMENT_TYPES, extension);

/** Anything but letters, digits, spaces and `._()-`: nothing a shell or a block could read as its own. */
const UNSAFE = /[^\p{L}\p{N} ._()-]/gu;

/**
 * The name a file is kept under: its own, without any folder, made of letters, digits, spaces and
 * `._()-` only, so that no shell reads anything of it but a name, with no leading dot, cut to a hundred
 * characters and two hundred bytes, its ending lowercased. Null for a kind of file a message does not carry.
 */
export function attachmentName(raw: string): string | null {
  const last = raw.split(/[\\/]/).pop() ?? "";
  // With the u flag a lone surrogate counts as one character, and is replaced like the others.
  const cleaned = last.normalize("NFC").replace(UNSAFE, "_");
  const trimmed = cleaned
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "");
  const extension = extensionOf(trimmed);
  if (!isKnownExtension(extension)) {
    return null;
  }
  let stem = [...trimmed.slice(0, trimmed.length - extension.length - 1)].slice(0, MAX_STEM_CHARS);
  while (stem.length > 0 && Buffer.byteLength(`${stem.join("")}.${extension}`) > MAX_NAME_BYTES) {
    stem = stem.slice(0, -1);
  }
  const kept = stem.join("").trim();
  return `${kept === "" ? "file" : kept}.${extension}`;
}

const startsWith = (bytes: Uint8Array, ...expected: number[]): boolean =>
  expected.every((value, index) => bytes[index] === value);

const ZIP = [0x50, 0x4b, 0x03, 0x04];
/** Older Word and Excel files, and Office Open files saved with a password. */
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Text: no NUL byte, or a byte-order mark for UTF-16, as Excel's « Unicode text » writes. */
function isText(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, 0xff, 0xfe) ||
    startsWith(bytes, 0xfe, 0xff) ||
    !bytes.subarray(0, 64 * 1024).includes(0)
  );
}

/** Whether `%PDF-` comes within the first kilobyte, where readers look for it. */
function isPdf(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 1024);
  for (let at = 0; at + 5 <= head.length; at += 1) {
    if (startsWith(head.subarray(at), 0x25, 0x50, 0x44, 0x46, 0x2d)) {
      return true;
    }
  }
  return false;
}

/**
 * The file's media type, when its first bytes are what its name says: a PDF has `%PDF-` in its first
 * kilobyte, the Office Open files are ZIP archives (OLE ones with a password), OpenDocument files ZIP
 * archives, a Word document OLE or RTF, an Excel sheet OLE or text, as some tools write HTML under that
 * name, and the text files are text. Null otherwise.
 */
export function attachmentType(name: string, bytes: Uint8Array): string | null {
  const extension = extensionOf(name);
  if (!isKnownExtension(extension)) {
    return null;
  }
  const type = STUDIO_ATTACHMENT_TYPES[extension];
  switch (extension) {
    case "pdf":
      return isPdf(bytes) ? type : null;
    case "docx":
    case "xlsx":
    case "pptx":
      return startsWith(bytes, ...ZIP) || startsWith(bytes, ...OLE) ? type : null;
    case "odt":
    case "ods":
      return startsWith(bytes, ...ZIP) ? type : null;
    case "doc":
      return startsWith(bytes, ...OLE) || startsWith(bytes, 0x7b, 0x5c, 0x72, 0x74, 0x66) ? type : null;
    case "xls":
      return startsWith(bytes, ...OLE) || isText(bytes) ? type : null;
    default:
      return isText(bytes) ? type : null;
  }
}

const tooLarge = () =>
  new AppError(413, "studio_attachment_too_large", "A file attached to a message is at most 10 MB.");

/** The request's body, counted as it comes in, refused past the limit, empty, or stalled. */
export async function readAttachment(
  body: ReadableStream<Uint8Array> | null,
  declaredBytes: number | undefined,
  maxBytes = MAX_STUDIO_ATTACHMENT_BYTES,
  idleMs = IDLE_MS,
): Promise<Uint8Array> {
  if (declaredBytes !== undefined && Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    throw tooLarge();
  }
  if (body === null) {
    throw badRequest("studio_attachment_empty", "The file is empty.");
  }
  const reader = body.getReader();
  const next = () =>
    new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new AppError(408, "studio_attachment_timeout", "The file stopped arriving.")),
        idleMs,
      );
      reader.read().then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await next();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (total === 0) {
    throw badRequest("studio_attachment_empty", "The file is empty.");
  }
  return Buffer.concat(chunks);
}

/** Checks a file's name and content: what it is kept as, or why it is refused. */
export function checkAttachment(rawName: string, bytes: Uint8Array): { name: string; type: string } {
  const name = attachmentName(rawName);
  if (name === null) {
    throw typeRefused("Attach a PDF, Word, Excel, PowerPoint, CSV or text file.");
  }
  const type = attachmentType(name, bytes);
  if (type === null) {
    throw typeRefused("The file is not what its name says.");
  }
  return { name, type };
}

interface Slots {
  total: number;
  byPerson: Map<string, number>;
}
const slots = new WeakMap<object, Slots>();

/**
 * A place among the files being saved, given back by the function it returns: each is held in memory
 * while it is, so only a few at a time, and fewer for one person.
 */
export function takeAttachmentSlot(deps: object, person: string): () => void {
  let state = slots.get(deps);
  if (state === undefined) {
    state = { total: 0, byPerson: new Map() };
    slots.set(deps, state);
  }
  const mine = state.byPerson.get(person) ?? 0;
  if (state.total >= MAX_AT_ONCE || mine >= MAX_AT_ONCE_PER_PERSON) {
    throw new AppError(
      429,
      "studio_attachment_busy",
      "Other files are being saved: send this one again in a moment.",
    );
  }
  state.total += 1;
  state.byPerson.set(person, mine + 1);
  let given = false;
  const held = state;
  return () => {
    if (given) {
      return;
    }
    given = true;
    held.total -= 1;
    const left = (held.byPerson.get(person) ?? 1) - 1;
    if (left <= 0) {
      held.byPerson.delete(person);
    } else {
      held.byPerson.set(person, left);
    }
  };
}

/** Writes a checked file in the project's folder, from inside the agent server's container. */
export async function writeAttachment(
  deps: Pick<AppDeps, "docker">,
  agent: { project: string; service: string },
  workspaceDir: string,
  file: { name: string; type: string; bytes: Uint8Array },
): Promise<StudioAttachment> {
  const folder = randomBytes(8).toString("hex");
  let output: string;
  try {
    const outcome = await runInDatabase(
      deps,
      qualifiedName(agent.project, agent.service),
      {
        command: [
          "python3",
          "-c",
          ATTACH_SCRIPT,
          workspaceDir,
          folder,
          file.name,
          String(MAX_ATTACHMENTS_BYTES),
        ],
        stdin: file.bytes,
      },
      { timeoutMs: ATTACH_TIMEOUT_MS },
    );
    output = outcome.output;
  } catch (error) {
    if (error instanceof DockerDriverError) {
      throw conflict(
        "studio_agent_not_running",
        `The agent server's service ${agent.project}/${agent.service} is not running.`,
      );
    }
    throw error;
  }
  const line = output.split("\n").find((one) => one.startsWith(ATTACH_PREFIX));
  let result: { ok?: unknown; code?: unknown } = {};
  try {
    result = line === undefined ? {} : (JSON.parse(line.slice(ATTACH_PREFIX.length)) as typeof result);
  } catch {
    result = {};
  }
  if (result.ok !== true) {
    if (result.code === "no_git") {
      throw conflict("studio_attachment_no_git", "The project's folder is not a git repository.");
    }
    if (result.code === "full") {
      throw conflict(
        "studio_attachments_full",
        `The project's attached files take ${MAX_ATTACHMENTS_BYTES / 1024 / 1024} MB already: ask the agent to delete those it no longer needs, in ${ATTACHMENTS_DIR}.`,
      );
    }
    throw serviceUnavailable(
      "studio_attachment_failed",
      "The file could not be saved in the project's folder.",
    );
  }
  // Where it is, as the panel chose it: never what the script says.
  return {
    path: `${ATTACHMENTS_DIR}/${folder}/${file.name}`,
    name: file.name,
    size: file.bytes.byteLength,
    type: file.type,
  };
}
