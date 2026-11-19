import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { AppError, conflict } from "../../core/errors";
import {
  assertDockerfileAllowed,
  IMAGE_NOT_ALLOWED,
  isDockerFrontend,
  normalizeImageReference,
  readDockerfileImages,
} from "../services/foreign-images";
import { readPlainFile } from "./checkout";
import { contextImage, isStackImageName } from "./images";
import { fromStackFolder } from "./own-folder";

/**
 * A stack's builds run in the server's one BuildKit, next to every project's images. The override has
 * them pull every image they name from its registry, and what they read is checked here first, as for
 * an App: the images a Dockerfile names, with the build arguments the stack passes, and the frontend
 * it asks for, from its syntax line or from a `BUILDKIT_SYNTAX` argument, since any other frontend than
 * Docker's own decides for itself which images it reads.
 */

type Record_ = Record<string, unknown>;

const isRecord = (value: unknown): value is Record_ =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null ? [] : [value]);

/** A context BuildKit would fetch for itself: what it builds is then out of the panel's sight. */
const FETCHED = /^(?:[a-z][a-z0-9+.-]*:\/\/|[^\s/:@]+@[^\s/:]+:)/i;

/** Far more than any Dockerfile needs, and a bound on what one can make the panel hold. */
const MAX_DOCKERFILE_BYTES = 1024 * 1024;

/** The values a build passes, as Compose resolves them: a mapping, or a list of `name=value`. */
function buildArgs(args: unknown): Map<string, string> {
  const values = new Map<string, string>();
  if (isRecord(args)) {
    for (const [key, value] of Object.entries(args)) {
      if (value !== null && value !== undefined) {
        values.set(key, String(value));
      }
    }
    return values;
  }
  for (const entry of asList(args).map(String)) {
    const separator = entry.indexOf("=");
    if (separator !== -1) {
      values.set(entry.slice(0, separator), entry.slice(separator + 1));
    }
  }
  return values;
}

/**
 * A Dockerfile outside the stack's folder, which an administrator confirmed as access to the server:
 * read as a plain file, without waiting on anything that isn't one.
 */
async function readConfirmedFile(path: string): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (handle === null) {
    return null;
  }
  try {
    const stats = await handle.stat();
    return stats.isFile() && stats.size <= MAX_DOCKERFILE_BYTES
      ? (await handle.readFile()).toString("utf8")
      : null;
  } finally {
    await handle.close();
  }
}

/** An image a stack names that a build or a mount takes from the store, pulled before anything starts. */
export interface StackPull {
  service: string;
  image: string;
  use: "volume" | "context";
}

export interface BuildCheck {
  pulls: StackPull[];
  /** What to tell whoever deploys: images a Dockerfile names that only this server has. */
  notes: string[];
}

const ofBuild = (service: string, error: unknown): unknown =>
  error instanceof AppError && error.code === IMAGE_NOT_ALLOWED
    ? conflict(IMAGE_NOT_ALLOWED, `This Compose file can't run, in the build of ${service}: ${error.message}`)
    : error;

/** Images of this project that no registry has, which a build that pulls can't start from. */
function builtHere(image: string, project: string): boolean {
  const name = normalizeImageReference(image);
  return name.startsWith(`opsifier/${project}/`) || (name.split("/", 1)[0] ?? "").startsWith(`${project}_`);
}

/**
 * Checks every build of what Compose resolved before anything runs, and says which images the stack
 * takes from the store by name. Paths were walked for links already: the Dockerfile is read through
 * folders alone when it is the stack's.
 */
export async function checkBuilds(
  config: Record_,
  scope: { root: string; projectDirectory: string; project: string; stack: string },
): Promise<BuildCheck> {
  const pulls: StackPull[] = [];
  const notes: string[] = [];
  const services = isRecord(config.services) ? config.services : {};
  const pull = (service: string, image: string, use: StackPull["use"]) => {
    if (!isStackImageName(image, scope.stack)) {
      pulls.push({ service, image, use });
    }
  };
  for (const [name, service] of Object.entries(services)) {
    if (!isRecord(service)) {
      continue;
    }
    for (const entry of asList(service.volumes)) {
      if (isRecord(entry) && entry.type === "image" && typeof entry.source === "string") {
        pull(name, entry.source, "volume");
      }
    }
    if (!isRecord(service.build)) {
      continue;
    }
    const build = service.build;
    const context = typeof build.context === "string" ? build.context : ".";
    if (FETCHED.test(context)) {
      throw conflict(
        "compose_invalid",
        `This Compose file can't run: ${name} builds from ${context}, which BuildKit would fetch for itself, so nothing could check what it builds or the images it starts from. Build from a folder of the stack.`,
      );
    }
    for (const value of isRecord(build.additional_contexts) ? Object.values(build.additional_contexts) : []) {
      const image = typeof value === "string" ? contextImage(value) : null;
      if (image !== null) {
        pull(name, image, "context");
      }
    }
    const args = buildArgs(build.args);
    const syntax = args.get("BUILDKIT_SYNTAX");
    if (syntax !== undefined && syntax.trim() !== "" && !isDockerFrontend(syntax)) {
      throw conflict(
        IMAGE_NOT_ALLOWED,
        `This Compose file can't run: the build of ${name} passes BUILDKIT_SYNTAX=${syntax}, a frontend other than Docker's own, docker/dockerfile, which could read every project's images on this server. Remove that build argument.`,
      );
    }
    let dockerfile: string | null;
    let shown: string;
    if (typeof build.dockerfile_inline === "string") {
      dockerfile = build.dockerfile_inline;
      shown = "dockerfile_inline";
    } else {
      const from = isAbsolute(context) ? context : join(scope.projectDirectory, context);
      const name_ = typeof build.dockerfile === "string" ? build.dockerfile : "Dockerfile";
      const path = isAbsolute(name_) ? name_ : join(from, name_);
      const inside = fromStackFolder(scope.root, path);
      dockerfile =
        inside === null
          ? await readConfirmedFile(path)
          : await readPlainFile(scope.root, path, MAX_DOCKERFILE_BYTES);
      shown = inside === null ? path : `./${inside}`;
    }
    if (dockerfile === null) {
      throw conflict(
        "compose_invalid",
        `This Compose file can't run: the Dockerfile of ${name}, ${shown}, can't be read as a plain file of at most 1 MiB, so nothing could check the images its build starts from.`,
      );
    }
    try {
      assertDockerfileAllowed(dockerfile, scope.project, { buildArgs: args, strict: true });
    } catch (error) {
      throw ofBuild(name, error);
    }
    const onlyHere = readDockerfileImages(dockerfile, args).images.filter((image) =>
      builtHere(image, scope.project),
    );
    if (onlyHere.length > 0) {
      notes.push(
        `The Dockerfile of ${name} names ${onlyHere.join(", ")}, which only this server has: a build pulls every image it starts from, so it can't start from one built here. Build it in a stage of that Dockerfile instead, or, for what another child of the stack builds, name that child as a context of the build (additional_contexts: { base: "service:<child>" }) and start FROM base.`,
      );
    }
  }
  return { pulls, notes };
}
