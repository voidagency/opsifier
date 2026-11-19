import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { imageReference } from "@opsifier/contract";
import type { ActionContext } from "../../../../core/actions";
import type { AppDeps } from "../../../../core/context";
import {
  assertImageAllowed,
  imageNotAllowed,
  MAX_DOCKERFILE_LENGTH,
  normalizeImageReference,
  readDockerfileImages,
  refusalsOf,
} from "../../../services/foreign-images";
import { logPullProgress } from "../../../services/pull-progress";
import {
  declaredBuildArgs,
  NIXPACKS_BUILD_SCRIPT,
  NIXPACKS_DOCKERFILE,
  NIXPACKS_FOLDER,
  STEERS_BUILDKIT,
} from "./builders";
import { isReservedBuildVariable } from "./environment";
import { isInside, resolveInside, SourcePathError } from "./paths";
import {
  type BuilderBuildpack,
  buildpackLocators,
  buildpackSource,
  DescriptorError,
  readToml,
} from "./project-descriptor";

/**
 * A Dockerfile build sends every image it names to its registry with `--pull`, and Nixpacks only writes
 * the Dockerfile that the panel then builds the same way. The other builders have no such option, or
 * decide for themselves: pack takes the daemon's copy of an image whenever the registry says it has none
 * or refuses, and Railpack's frontend resolves what its plan names its own way. Either could then build
 * from an image another project has on this server, or pulled with its own credentials.
 *
 * So before such a build runs, the panel reads which images it will use, as the builder itself wrote
 * them down, holds them to what the project may use, and pulls each one with no credentials at all. An
 * image only another project could pull then stops the build here, and what the builder finds on the
 * server afterwards is what the registry gave everyone.
 */

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * A Dockerfile a build is about to read, at most as long as the panel reads one: a repository's, or the
 * one Nixpacks writes from what the project says, can be any size.
 */
export async function readDockerfileText(path: string, shown: string): Promise<string> {
  if ((await stat(path)).size > MAX_DOCKERFILE_LENGTH) {
    throw new Error(
      `${shown} is larger than the ${MAX_DOCKERFILE_LENGTH / 1024} KiB the panel reads in a Dockerfile, so nothing was built.`,
    );
  }
  return readFile(path, "utf8");
}

/** Pulls each image once, and stops the build at the first a registry won't give. */
export async function pullBaseImages(
  deps: Pick<AppDeps, "docker">,
  images: readonly string[],
  ctx: Pick<ActionContext, "log" | "signal">,
): Promise<void> {
  for (const image of new Set(images)) {
    if (!imageReference.safeParse(image).success) {
      throw new Error(`The build names ${image}, which is not an image reference, so nothing was built.`);
    }
    ctx.log(`Pulling base image ${image}`);
    try {
      await deps.docker.pullImage(image, { signal: ctx.signal, onProgress: logPullProgress(ctx) });
    } catch (error) {
      ctx.signal.throwIfAborted();
      throw new Error(`Could not pull ${image} from its registry, so nothing was built: ${describe(error)}`, {
        cause: error,
      });
    }
  }
}

/** What `nixpacks build --out` wrote that the panel builds from. */
export interface NixpacksOutput {
  /** Every image its Dockerfile names. */
  images: string[];
  /** The build arguments its Dockerfile declares: all that a build of it reads. */
  argumentNames: string[];
  /** The values Nixpacks would have given them, as its script writes them. */
  values: Map<string, string>;
  /** What the build of it is given for those arguments: the values its images were read with. */
  arguments: NixpacksArguments;
}

/** What a build of Nixpacks's output is given for the arguments its Dockerfile declares. */
export interface NixpacksArguments {
  /** Passed by name, their values in the Docker CLI's environment: the project's own, or Nixpacks's. */
  names: string[];
  /** Nixpacks's values for the names above that are not the project's. */
  values: Record<string, string>;
  /** Nixpacks's own values under names that would act on the Docker CLI there: passed as NAME=VALUE. */
  literal: Array<readonly [string, string]>;
  /** Names with a value that steer BuildKit itself, which no build is given. */
  steering: string[];
  /** Every value the build ends up with, by name. */
  passed: Map<string, string>;
}

/**
 * The project's own value for an argument it has a build variable for, Nixpacks's otherwise, and none
 * for a name that steers BuildKit. One reckoning for both the check of the Dockerfile's images and the
 * build: a Dockerfile can name its image through an argument, as Nixpacks's own assets can make it do.
 */
export function nixpacksArguments(
  argumentNames: readonly string[],
  scriptValues: ReadonlyMap<string, string>,
  own: ReadonlyMap<string, string>,
): NixpacksArguments {
  const found: NixpacksArguments = { names: [], values: {}, literal: [], steering: [], passed: new Map() };
  for (const name of argumentNames) {
    const value = scriptValues.get(name);
    const mine = own.get(name);
    if (STEERS_BUILDKIT.test(name)) {
      if (value !== undefined) {
        found.steering.push(name);
      }
    } else if (isReservedBuildVariable(name)) {
      // Nixpacks's own, as Ruby's MALLOC_ARENA_MAX: for the build, never for the Docker CLI's environment.
      if (value !== undefined) {
        found.literal.push([name, value]);
        found.passed.set(name, value);
      }
    } else if (mine !== undefined) {
      found.names.push(name);
      found.passed.set(name, mine);
    } else if (value !== undefined) {
      found.names.push(name);
      found.values[name] = value;
      found.passed.set(name, value);
    }
  }
  return found;
}

const isFile = (path: string): Promise<boolean> =>
  lstat(path).then(
    (found) => found.isFile(),
    () => false,
  );

const isDirectory = (path: string): Promise<boolean> =>
  lstat(path).then(
    (found) => found.isDirectory(),
    () => false,
  );

/**
 * Reads what Nixpacks wrote, held to the same rules as any Dockerfile. Its Dockerfile declares the
 * arguments of its build, and Nixpacks puts their values, its own and the project's, only on the
 * `docker build` line of its script. Its container could have left links where its files go: the panel
 * reads files, never through a link.
 */
export async function readNixpacksOutput(
  context: string,
  project: string,
  own: ReadonlyMap<string, string> = new Map(),
): Promise<NixpacksOutput> {
  const out = context;
  const dockerfile = join(out, NIXPACKS_DOCKERFILE);
  const script = join(out, NIXPACKS_BUILD_SCRIPT);
  if (!(await isDirectory(join(out, NIXPACKS_FOLDER)))) {
    throw new Error(`Nixpacks wrote no ${NIXPACKS_FOLDER} folder, so nothing was built.`);
  }
  for (const [path, what] of [
    [dockerfile, "what it would build"],
    [script, "which values its build takes"],
  ] as const) {
    if (!(await isFile(path))) {
      throw new Error(
        `Nixpacks wrote no ${path.slice(out.length + 1)}, so the panel can't tell ${what}. Nothing was built.`,
      );
    }
  }
  const text = await readDockerfileText(dockerfile, `Nixpacks's ${NIXPACKS_DOCKERFILE}`);
  const argumentNames = [...declaredBuildArgs(text)];
  const values = nixpacksArgumentValues(
    await readDockerfileText(script, NIXPACKS_BUILD_SCRIPT),
    new Set(argumentNames),
  );
  const given = nixpacksArguments(argumentNames, values, own);
  // Read with the values the build is given, as any Dockerfile is.
  const read = readDockerfileImages(text, given.passed);
  const [refusal] = refusalsOf(read, project, true);
  if (refusal !== undefined) {
    throw imageNotAllowed(refusal);
  }
  return { images: read.images, argumentNames, values, arguments: given };
}

/** Where an argument starts on the line Nixpacks writes: `--build-arg NAME=`, after a space. */
const BUILD_ARG = / --build-arg ([A-Za-z_][A-Za-z0-9_]*)=/g;

/**
 * The values Nixpacks gives the arguments of its build, from the script it writes: one `docker build`
 * line whose words it joins with spaces as they are, unquoted, so that a value can hold spaces, quotes
 * or newlines. A value runs up to the next ` --build-arg ` that names one of `names`, or to the end of
 * the script, less the newline that ends it. A name given twice keeps its last value, as it would in a
 * build.
 */
export function nixpacksArgumentValues(script: string, names: ReadonlySet<string>): Map<string, string> {
  const starts = [...script.matchAll(BUILD_ARG)].filter((match) => names.has(match[1] ?? ""));
  const values = new Map<string, string>();
  for (const [index, match] of starts.entries()) {
    const from = (match.index ?? 0) + match[0].length;
    const next = starts[index + 1];
    values.set(
      match[1] ?? "",
      next === undefined ? script.slice(from).replace(/\r?\n$/, "") : script.slice(from, next.index),
    );
  }
  return values;
}

/** Far more than a plan holds: what the panel reads of one. */
const MAX_PLAN_LENGTH = 4 * 1024 * 1024;

/**
 * Every image a Railpack plan names, under `image` wherever it sits in the plan. The plan is a file
 * Railpack's container wrote, read as one: never through a link it could have left in its place.
 */
export async function railpackBaseImages(planFile: string, project: string): Promise<string[]> {
  let plan: unknown;
  try {
    if (!(await isFile(planFile))) {
      throw new Error("Railpack wrote no plan.");
    }
    if ((await stat(planFile)).size > MAX_PLAN_LENGTH) {
      throw new Error(`it is larger than the ${MAX_PLAN_LENGTH / 1024 / 1024} MiB the panel reads.`);
    }
    plan = JSON.parse(await readFile(planFile, "utf8"));
  } catch (error) {
    throw new Error(`Railpack's plan can't be read, so nothing was built: ${describe(error)}`, {
      cause: error,
    });
  }
  const images = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value !== null && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (key.toLowerCase() === "image" && typeof inner === "string" && inner.trim() !== "") {
          images.add(inner.trim());
        }
        visit(inner);
      }
    }
  };
  visit(plan);
  for (const image of images) {
    assertImageAllowed(image, project);
  }
  return [...images];
}

/** The label a Cloud Native Buildpacks builder describes itself in, run image included. */
export const BUILDER_METADATA_LABEL = "io.buildpacks.builder.metadata";

interface BuilderMetadata {
  images?: Array<{ image?: unknown }>;
  stack?: { runImage?: { image?: unknown } };
  buildpacks?: Array<{ id?: unknown; version?: unknown }>;
}

function builderMetadata(labels: Readonly<Record<string, string>>): BuilderMetadata | null {
  const raw = labels[BUILDER_METADATA_LABEL];
  if (raw === undefined) {
    return null;
  }
  try {
    const metadata = JSON.parse(raw) as unknown;
    return metadata !== null && typeof metadata === "object" ? (metadata as BuilderMetadata) : null;
  } catch {
    return null;
  }
}

/** The run image a builder names: the first of its run images, or its stack's in older builders. */
export function builderRunImage(labels: Readonly<Record<string, string>>): string | null {
  const metadata = builderMetadata(labels);
  const image = metadata?.images?.[0]?.image ?? metadata?.stack?.runImage?.image;
  return typeof image === "string" && image.trim() !== "" ? image.trim() : null;
}

/** The buildpacks a builder holds, which pack takes from it when a project names one of them. */
export function builderBuildpacks(labels: Readonly<Record<string, string>>): BuilderBuildpack[] {
  const listed = builderMetadata(labels)?.buildpacks;
  return (Array.isArray(listed) ? listed : []).flatMap((buildpack) =>
    typeof buildpack?.id === "string"
      ? [{ id: buildpack.id, version: typeof buildpack.version === "string" ? buildpack.version : "" }]
      : [],
  );
}

/**
 * What a simulated registry's builder says about itself: a run image of its own, as a real one does,
 * and a buildpack. The fake driver serves the panel's own builders with it, so that a development
 * server builds.
 */
export const simulatedBuilderLabels = (builder: string): Record<string, string> => ({
  [BUILDER_METADATA_LABEL]: JSON.stringify({
    images: [{ image: `${normalizeImageReference(builder)}-run:latest` }],
    buildpacks: [{ id: "simulated/procfile", version: "1.0.0" }],
  }),
});

/** Where pack reads a project's own settings, the buildpacks it adds included. */
export const PROJECT_DESCRIPTOR = "project.toml";

/**
 * The buildpacks a project's `project.toml` adds that come from images, held to the rule, for the panel
 * to pull first: pack fetches them with its pull policy and, when a registry says it has none or
 * refuses, takes the daemon's copy. Each is resolved as pack resolves it (see project-descriptor.ts),
 * so an image named without `docker://` is one too. One from the Buildpack Registry, which pack
 * resolves to an image of its own finding, is refused, as is a folder or archive outside the source,
 * which pack would read on the panel's own disk, and a file that leads out of the source.
 */
export async function projectBuildpackImages(
  context: string,
  project: string,
  builder: readonly BuilderBuildpack[],
): Promise<string[]> {
  let path: string;
  try {
    path = await resolveInside(context, PROJECT_DESCRIPTOR, PROJECT_DESCRIPTOR);
  } catch (error) {
    if (error instanceof SourcePathError && error.message.includes("does not exist")) {
      return [];
    }
    throw error;
  }
  if (!(await isFile(path))) {
    return [];
  }
  if ((await stat(path)).size > MAX_DOCKERFILE_LENGTH) {
    throw new Error(`${PROJECT_DESCRIPTOR} is larger than the panel reads, so nothing was built.`);
  }
  let locators: string[];
  try {
    locators = buildpackLocators(readToml(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof DescriptorError) {
      throw new Error(`${PROJECT_DESCRIPTOR} can't be read, so nothing was built: ${error.message}.`);
    }
    throw error;
  }
  const realContext = await realpath(context);
  const images: string[] = [];
  for (const locator of locators) {
    const source = await buildpackSource(locator, context, builder);
    if (source.kind === "registry") {
      throw new Error(
        `${PROJECT_DESCRIPTOR} names the buildpack ${locator}, which pack looks up in the Buildpack Registry and fetches as an image the panel can't check first, so nothing was built. Name its image instead, as docker://<image>, or one of the builder's own buildpacks.`,
      );
    }
    if (source.kind === "path") {
      // pack reads a folder or an archive from the panel's own disk: only one of the source's is let be.
      const real = source.path === null ? null : await realpath(source.path).catch(() => null);
      if (real === null || !isInside(realContext, real)) {
        throw new Error(
          `${PROJECT_DESCRIPTOR} names the buildpack ${locator}, which is outside the source or not found in it, so nothing was built.`,
        );
      }
    }
    if (source.kind === "image") {
      assertImageAllowed(source.reference, project);
      images.push(source.reference);
    }
  }
  return images;
}

/** A builder as a build uses it: the run image the panel gives pack, and the buildpacks it holds. */
export interface PreparedBuilder {
  runImage: string;
  buildpacks: BuilderBuildpack[];
}

/**
 * Pulls the builder, reads the run image it names, holds that to the rule too and pulls it, and answers
 * it, for pack to be given explicitly. pack would otherwise choose among the builder's run images and
 * their mirrors by itself, and take the daemon's copy of whichever it chose.
 */
export async function prepareBuilder(
  deps: Pick<AppDeps, "docker">,
  builder: string,
  project: string,
  ctx: Pick<ActionContext, "log" | "signal">,
): Promise<PreparedBuilder> {
  assertImageAllowed(builder, project);
  await pullBaseImages(deps, [builder], ctx);
  const labels = (await deps.docker.inspectImage(builder))?.labels ?? {};
  const runImage = builderRunImage(labels);
  if (runImage === null) {
    throw new Error(
      `${builder} does not say which run image it uses, so nothing was built. Choose another builder.`,
    );
  }
  assertImageAllowed(runImage, project);
  ctx.log(`${builder} runs its builds on ${runImage}`);
  await pullBaseImages(deps, [runImage], ctx);
  return { runImage, buildpacks: builderBuildpacks(labels) };
}
