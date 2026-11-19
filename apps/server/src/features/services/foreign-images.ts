import { type AppError, badRequest, conflict } from "../../core/errors";
import { type DockerfileImages, readDockerfileImages, TOO_MUCH_TO_READ } from "./dockerfile-reader";

/**
 * Every image on the server lives in one Docker store, which every project's builds and services draw
 * from by name, next to whatever any of them pulled with credentials of its own. The panel names what it
 * builds after the project it belongs to, `opsifier/<project>/<service>`, and keeps every version it
 * deploys as `opsifier/releases/<service id>:<n>`; a Compose stack names its images after
 * `<project>_<service>`. Project names hold no underscore and none is called `releases`, so each of
 * those names says whose it is, and what a project names may be neither another's nor the server's.
 *
 * Names only go so far: an image another project pulled from a private registry has a name like any
 * other. What keeps a project from that is that the panel always has the registry answer, with the
 * project's own credentials: a deployment pulls, a build passes `--pull`.
 */

export { type DockerfileImages, MAX_DOCKERFILE_LENGTH, readDockerfileImages } from "./dockerfile-reader";

/** What every refusal of an image answers, whether a request was refused or a deployment stopped. */
export const IMAGE_NOT_ALLOWED = "image_not_allowed";

/** Whose an image is, when it is not the project's to use. */
export type ImageOwner = "another-project" | "server";

export type ImageRefusalReason =
  | ImageOwner
  /** A Dockerfile frontend other than Docker's own, which could read any image on the server. */
  | "frontend"
  /** A substitution the reader can't work out, so it can't say which image it names. */
  | "unresolved";

export interface ImageRefusal {
  reference: string;
  reason: ImageRefusalReason;
}

const DOCKER_HUB = /^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//;

/**
 * A reference as two names for the same image compare: lowercase, without its tag or digest, and
 * without what Docker Hub's names leave out (`docker.io/`, `library/`).
 */
export function normalizeImageReference(reference: string): string {
  const name = (reference.trim().toLowerCase().split("@", 1)[0] ?? "").trim();
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  const repository = colon > slash ? name.slice(0, colon) : name;
  return repository.replace(DOCKER_HUB, "").replace(/^library\//, "");
}

/**
 * Null when `project` may use the image as far as its name goes. Under `opsifier/` only the project's
 * own `opsifier/<project>/…` is: every release is the server's, whatever a project is called, and so is
 * anything else there. A name whose first part is `<project>_…` is a Compose stack's, of that project.
 */
export function imageOwner(reference: string, project: string): ImageOwner | null {
  const parts = normalizeImageReference(reference).split("/");
  const [first = "", second] = parts;
  if (first === "opsifier" && second !== undefined) {
    if (second === "releases" || parts.length < 3) {
      return "server";
    }
    return second === project ? null : "another-project";
  }
  // A registry's host comes first when there is one, and no host has an underscore.
  const underscore = first.indexOf("_");
  if (underscore !== -1 && first.slice(0, underscore) !== project) {
    return "another-project";
  }
  return null;
}

export const isForeignImage = (reference: string, project: string): boolean =>
  imageOwner(reference, project) !== null;

/** Docker's own Dockerfile frontends. Any other runs inside BuildKit and decides itself what it reads. */
const DOCKER_FRONTENDS = new Set(["docker/dockerfile", "docker/dockerfile-upstream"]);

/** What a refusal names when the whole file is JSON, which BuildKit searches for a frontend too. */
const JSON_DOCUMENT = "a JSON document";

export const isDockerFrontend = (reference: string): boolean =>
  DOCKER_FRONTENDS.has(normalizeImageReference(reference));

/** Whether an image built on this server under the project's own name: no registry has it. */
export const isOwnBuiltImage = (reference: string, project: string): boolean =>
  normalizeImageReference(reference).startsWith(`opsifier/${project}/`);

export interface DockerfileCheck {
  /** The values the build passes, which replace the defaults of the arguments the file declares. */
  buildArgs?: ReadonlyMap<string, string>;
  /**
   * Whether a name the reader can't work out is refused. Only a build knows every value a substitution
   * can take, so saving lets it through and the build decides.
   */
  strict?: boolean;
}

/** Everything in a Dockerfile `project` may not use, in the order it was found. */
export function dockerfileRefusals(
  dockerfile: string,
  project: string,
  { buildArgs, strict = false }: DockerfileCheck = {},
): ImageRefusal[] {
  return refusalsOf(readDockerfileImages(dockerfile, buildArgs), project, strict);
}

/** {@link dockerfileRefusals} of a file already read, for a caller that wants what was read too. */
export function refusalsOf(read: DockerfileImages, project: string, strict: boolean): ImageRefusal[] {
  return [
    ...(read.json ? [{ reference: JSON_DOCUMENT, reason: "frontend" } satisfies ImageRefusal] : []),
    ...read.frontends
      .filter((frontend) => !isDockerFrontend(frontend))
      .map((reference): ImageRefusal => ({ reference, reason: "frontend" })),
    ...read.images.flatMap((reference): ImageRefusal[] => {
      const owner = imageOwner(reference, project);
      return owner === null ? [] : [{ reference, reason: owner }];
    }),
    ...(strict
      ? read.unresolved.map((reference): ImageRefusal => ({ reference, reason: "unresolved" }))
      : []),
  ];
}

const MESSAGES: Record<ImageRefusalReason, (reference: string) => { message: string; field: string }> = {
  "another-project": (reference) => ({
    message: `${reference} is an image of another project on this server, which this project can't use. Name an image from a registry.`,
    field: "Belongs to another project",
  }),
  server: (reference) => ({
    message: `${reference} is one of this server's own images, under opsifier/, which no project can use. Name an image from a registry.`,
    field: "Belongs to this server",
  }),
  frontend: (reference) => ({
    message:
      reference === JSON_DOCUMENT
        ? "This Dockerfile is a JSON document, which BuildKit reads for a frontend to build it with. Write it as a Dockerfile."
        : `This Dockerfile asks for the frontend ${reference}. Only Docker's own, docker/dockerfile, builds here: another frontend could read every project's images on this server.`,
    field: "Only docker/dockerfile can build here",
  }),
  unresolved: (reference) => ({
    message:
      reference === TOO_MUCH_TO_READ
        ? "This Dockerfile names more images, or more ways to spell them, than the panel reads in one file. Name its images plainly."
        : `This Dockerfile names an image through ${reference}, which the panel can't work out. Write the name out, or take it from a build argument as $NAME.`,
    field: "Name the image plainly",
  }),
};

/**
 * The error for a refusal. Answering a request, it is a 400 that names the field; stopping a deployment,
 * a 409, since what was saved is what is in the way.
 */
export function imageNotAllowed(refusal: ImageRefusal, field?: string): AppError {
  const { message, field: short } = MESSAGES[refusal.reason](refusal.reference);
  return field === undefined
    ? conflict(IMAGE_NOT_ALLOWED, message)
    : badRequest(IMAGE_NOT_ALLOWED, message, { [field]: short });
}

export function assertImageAllowed(reference: string, project: string, field?: string): void {
  const owner = imageOwner(reference, project);
  if (owner !== null) {
    throw imageNotAllowed({ reference, reason: owner }, field);
  }
}

export function assertDockerfileAllowed(
  dockerfile: string,
  project: string,
  check: DockerfileCheck & { field?: string } = {},
): void {
  const [refusal] = dockerfileRefusals(dockerfile, project, check);
  if (refusal !== undefined) {
    throw imageNotAllowed(refusal, check.field);
  }
}
