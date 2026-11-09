import { z } from "zod";

const IMAGE_REFERENCE =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

/** Checks the shape only. Saving never contacts a registry, so a tag that does not exist yet is fine. */
export const imageReference = z
  .string()
  .trim()
  .min(1, "Required")
  .max(512, "This is too long")
  .regex(IMAGE_REFERENCE, "Enter an image such as name:tag");

const MAX_PATH_CHARS = 1024;
const MAX_COMMAND_CHARS = 4096;
const MAX_PACKAGE_LIST_CHARS = 2048;

/** The largest archive the panel accepts. */
export const MAX_UPLOAD_BYTES = 1024 ** 3;
/** The largest inline Dockerfile. It travels in JSON, inside the API's body limit. */
export const MAX_DOCKERFILE_CHARS = 256 * 1024;

export const defaultNixpacksVersion = "1.41.0";
export const nixpacksVersions = ["1.41.0", "1.40.0", "1.39.0", "1.38.0", "1.37.0", "1.36.0"] as const;
export const defaultRailpackVersion = "0.17.1";
export const railpackVersions = [
  "0.17.1",
  "0.17.0",
  "0.16.0",
  "0.15.4",
  "0.15.0",
  "0.14.0",
  "0.13.0",
  "0.12.0",
  "0.11.0",
  "0.10.0",
  "0.9.2",
] as const;
/** The Cloud Native Buildpacks command line. The image installs exactly this one. */
export const packVersion = "0.40.0";
/** Each one fixed to a digest or to a release that is never rebuilt, so the same code keeps building the same way. */
export const defaultBuildpacksBuilder =
  "heroku/builder:24@sha256:7eaa43fc56aefe79b3c35cd08399ba4852f168ad9836bc1144ea216ceb025d85";
export const buildpacksBuilders = [
  defaultBuildpacksBuilder,
  "heroku/builder:22@sha256:4630eaab77371365c174bb39dcd1e43e9806f76588bb07c3fe7591bd13f4861c",
  "heroku/builder:20@sha256:237c875783e9ead0bc1eafa84535d58fc16d34777692d5b5ccaf965082f5d11a",
  "paketobuildpacks/builder-jammy-full:0.3.705",
  "paketobuildpacks/builder-jammy-base:0.4.681",
  "paketobuildpacks/builder-jammy-tiny:0.0.595",
] as const;

/** Earlier releases offered these, which move by themselves. Each one reads as its pinned equivalent. */
const SUPERSEDED_BUILDERS: Readonly<Record<string, string>> = {
  "heroku/builder:24": defaultBuildpacksBuilder,
  "heroku/builder:22":
    "heroku/builder:22@sha256:4630eaab77371365c174bb39dcd1e43e9806f76588bb07c3fe7591bd13f4861c",
  "heroku/builder:20":
    "heroku/builder:20@sha256:237c875783e9ead0bc1eafa84535d58fc16d34777692d5b5ccaf965082f5d11a",
  "paketobuildpacks/builder-jammy-full:latest": "paketobuildpacks/builder-jammy-full:0.3.705",
  "paketobuildpacks/builder-jammy-base:latest": "paketobuildpacks/builder-jammy-base:0.4.681",
  "paketobuildpacks/builder-jammy-tiny:latest": "paketobuildpacks/builder-jammy-tiny:0.0.595",
};

/** A reference that can't come to mean something else: a digest, or a tag that is a full release number. */
export function isPinnedBuilder(reference: string): boolean {
  if (reference.includes("@sha256:")) {
    return true;
  }
  const tag = /:([^:/]+)$/.exec(reference)?.[1];
  return tag !== undefined && /^v?\d+\.\d+\.\d+/.test(tag);
}

/** What the panel can unpack. The name only decides what is offered: the content is what gets read. */
export const archiveExtensions = [
  ".zip",
  ".tar",
  ".tar.gz",
  ".tgz",
  ".tar.bz2",
  ".tbz2",
  ".tar.xz",
  ".txz",
  ".tar.zst",
  ".tzst",
  ".7z",
  ".rar",
] as const;

export function isSupportedArchiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return archiveExtensions.some((extension) => lower.endsWith(extension));
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

const SAFE_REF = /^[A-Za-z0-9._/@+#=-]+$/;

/**
 * A branch, tag or commit, under the rules of `git check-ref-format` and tighter. A leading dash
 * could be read as an option, and everything else only ever reaches git as a ref.
 */
export function isValidGitRef(value: string): boolean {
  return (
    SAFE_REF.test(value) &&
    !value.startsWith("-") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    value !== "@" &&
    !value.endsWith(".") &&
    value.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

/** `user@host:path`, the short form of SSH. The user is required so a local path can't pass for one. */
const SCP_LIKE_REMOTE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:(?!-|\/\/)[A-Za-z0-9._~/@+-]+$/;
/** A percent-encoded newline or other control character in a URL is an attack on something downstream. */
const ENCODED_CONTROL = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;

/** `https://host/path` or `ssh://[user@]host[:port]/path`, with nothing the panel would then have to show. */
const URL_REMOTE =
  /^(https|ssh):\/\/(?:([A-Za-z0-9][A-Za-z0-9._~-]*)@)?([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::(\d{1,5}))?(\/[A-Za-z0-9._~%+@/-]+)$/;

/**
 * True for the only remotes the panel will contact: `https://`, `ssh://` and `user@host:path`.
 * Everything else, `file://`, `git://`, `ext::`, a bare local path or an option in disguise, is out.
 */
export function isAllowedGitRemote(value: string): boolean {
  if (
    /\s/.test(value) ||
    hasControlCharacter(value) ||
    ENCODED_CONTROL.test(value) ||
    value.startsWith("-")
  ) {
    return false;
  }
  if (SCP_LIKE_REMOTE.test(value)) {
    return true;
  }
  const match = URL_REMOTE.exec(value);
  if (match === null) {
    return false;
  }
  const [, scheme, user, , port] = match;
  // Credentials in a URL would be stored in plain text and shown back to the user.
  const hasCredentials = scheme === "https" && user !== undefined;
  return !hasCredentials && (port === undefined || Number(port) <= 65535);
}

/** Whether a stored remote is reached over SSH. Credentials are chosen from this, never by host. */
export function isSshRemote(remote: string): boolean {
  return !remote.startsWith("https://");
}

/** The forms a path may take in a repository are collapsed, so what is saved is what gets used. */
export function normalizeBuildPath(value: string): string {
  return `/${value
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/")}`;
}

const isSafeSegment = (segment: string) =>
  segment !== ".." && !segment.includes("\\") && !hasControlCharacter(segment);

function isSafeBuildPath(value: string): boolean {
  return value.split("/").every(isSafeSegment);
}

/** A file under the build path. `..` and absolute paths are refused outright, symlinks at build time. */
export function isSafeRelativeFile(value: string): boolean {
  if (value === "") {
    return true;
  }
  const segments = value.split("/");
  return !value.startsWith("/") && segments.every((segment) => segment !== "" && isSafeSegment(segment));
}

const stripDotSlash = (value: string) => value.replace(/^(?:\.\/)+/, "");

const relativeFile = (message: string) =>
  z
    .string()
    .trim()
    .max(MAX_PATH_CHARS, "This is too long")
    .overwrite(stripDotSlash)
    .refine(isSafeRelativeFile, message);

export const gitRef = z
  .string()
  .trim()
  .min(1, "Required")
  .max(255, "This is too long")
  .refine(isValidGitRef, "Enter a branch, tag or commit");

export const gitRemoteUrl = z
  .string()
  .trim()
  .min(1, "Required")
  .max(2048, "This is too long")
  .refine(isAllowedGitRemote, "Use an https:// or ssh:// address, or user@host:path");

const GITHUB_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;

/** `owner/repo`, the way GitHub writes it. A pasted `.git` suffix is ignored. */
export const githubRepository = z
  .string()
  .trim()
  .overwrite((value) => value.replace(/\.git$/, ""))
  .regex(GITHUB_REPOSITORY, "Expected the form owner/repo")
  .refine((value) => {
    const repo = value.split("/")[1];
    return repo !== "." && repo !== "..";
  }, "Expected the form owner/repo");

/** The root of the build inside the repository: `/` or a folder. */
export const buildPath = z
  .string()
  .trim()
  .min(1, "Required")
  .max(MAX_PATH_CHARS, "This is too long")
  .overwrite(normalizeBuildPath)
  .refine(isSafeBuildPath, "Use a path inside the repository, such as /apps/web");

/** Where the panel writes the environment in the source tree. Relative to the build path. */
export const envFilePath = relativeFile("Use a path inside the source, such as .env").min(1, "Required");

const toolVersion = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+$/, "Use a version such as 1.2.3");

const commandOverride = z
  .string()
  .trim()
  .max(MAX_COMMAND_CHARS, "This is too long")
  .refine((value) => !hasControlCharacter(value), "Write it on one line");

/** Space or comma separated names. Validated one by one so no option can hide among them. */
const packageList = (pattern: RegExp, message: string) =>
  z
    .string()
    .trim()
    .max(MAX_PACKAGE_LIST_CHARS, "This is too long")
    .refine((value) => splitPackages(value).every((name) => pattern.test(name)), message);

export function splitPackages(value: string): string[] {
  return value.split(/[\s,]+/).filter((name) => name !== "");
}

const nixPackages = packageList(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, "Use Nix package names");
const aptPackages = packageList(/^[a-z0-9][a-z0-9.+:-]*(?:=[A-Za-z0-9.+:~-]+)?$/, "Use APT package names");
const misePackages = packageList(
  /^[A-Za-z0-9][A-Za-z0-9._:/+-]*(?:@[A-Za-z0-9._+-]+)?$/,
  "Use packages written as name or name@version",
);

const dockerfileBuild = z.object({
  type: z.literal("dockerfile"),
  /** Blank means `Dockerfile`. Resolved from the build path, which is also the Docker context. */
  file: relativeFile("Use a path inside the build path, such as Dockerfile").default(""),
});

const buildpacksBuild = (builder: z.ZodType<string>) =>
  z.object({
    type: z.literal("buildpacks"),
    builder: builder.default(defaultBuildpacksBuilder),
  });

const pinnedBuilderReference = imageReference.refine(
  isPinnedBuilder,
  "Use a pinned builder: a full release such as 0.4.681, or a digest",
);

const nixpacksBuild = z.object({
  type: z.literal("nixpacks"),
  version: toolVersion.default(defaultNixpacksVersion),
  /** Each of these replaces the detected command instead of adding to it. */
  installCommand: commandOverride.default(""),
  buildCommand: commandOverride.default(""),
  startCommand: commandOverride.default(""),
  nixPackages: nixPackages.default(""),
  aptPackages: aptPackages.default(""),
});

const railpackBuild = z.object({
  type: z.literal("railpack"),
  version: toolVersion.default(defaultRailpackVersion),
  installCommand: commandOverride.default(""),
  buildCommand: commandOverride.default(""),
  startCommand: commandOverride.default(""),
  misePackages: misePackages.default(""),
  buildAptPackages: aptPackages.default(""),
  deployAptPackages: aptPackages.default(""),
});

/** How source code becomes an image. Null means: a Dockerfile if there is one, otherwise Nixpacks. */
export const buildConfig = z.discriminatedUnion("type", [
  dockerfileBuild,
  buildpacksBuild(pinnedBuilderReference),
  nixpacksBuild,
  railpackBuild,
]);
export type BuildConfig = z.infer<typeof buildConfig>;

/**
 * Reads what was saved: a superseded builder comes back as its pinned equivalent, and anything else that
 * isn't pinned is still read, so that the page can show it and the build can say what is wrong with it.
 */
export const storedBuildConfig = z.discriminatedUnion("type", [
  dockerfileBuild,
  buildpacksBuild(imageReference.transform((builder) => SUPERSEDED_BUILDERS[builder] ?? builder)),
  nixpacksBuild,
  railpackBuild,
]);
export type BuildType = BuildConfig["type"];

/** What leaves the server about a source. Passwords, keys and tokens never do. */
export const serviceSource = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("image"),
    image: z.string(),
    username: z.string().nullable(),
    hasPassword: z.boolean(),
  }),
  z.object({
    type: z.literal("github"),
    repository: z.string(),
    ref: z.string(),
    path: z.string(),
    /** True while a push webhook on the repository deploys this service. */
    autoDeploy: z.boolean(),
  }),
  z.object({
    type: z.literal("git"),
    url: z.string(),
    ref: z.string(),
    path: z.string(),
  }),
  z.object({
    type: z.literal("dockerfile"),
    dockerfile: z.string(),
  }),
  z.object({
    type: z.literal("upload"),
    fileName: z.string(),
    sizeBytes: z.number().int().min(0),
    uploadedAt: z.iso.datetime(),
    path: z.string(),
  }),
]);
export type ServiceSource = z.infer<typeof serviceSource>;
export type ServiceSourceType = ServiceSource["type"];

/** The source types that are built from code, as opposed to pulled or written out in full. */
export const buildableSourceTypes = ["github", "git", "upload"] as const;

export function isBuildableSourceType(type: ServiceSourceType): boolean {
  return (buildableSourceTypes as readonly string[]).includes(type);
}

/** GET /api/v1/projects/{project}/services/{service}/source */
export const sourceSettings = z.object({
  source: serviceSource.nullable(),
  build: buildConfig.nullable(),
  /** The deploy key's public half. The private half stays sealed on the server. */
  sshPublicKey: z.string().nullable(),
  /** What can be said about the deploy key without showing it. */
  sshKey: z
    .object({
      fingerprint: z.string(),
      /** The one repository it may be offered to. Null until it has been used for one. */
      boundTo: z.string().nullable(),
      createdAt: z.iso.datetime().nullable(),
    })
    .nullable(),
  /** Whether a GitHub token is stored, so the UI can offer the picker and auto-deploy. */
  githubConfigured: z.boolean(),
});
export type SourceSettings = z.infer<typeof sourceSettings>;

const buildField = buildConfig.nullable().optional();

/**
 * PUT /api/v1/projects/{project}/services/{service}/source
 *
 * Without `type` the body is an image. On an image, leaving `password` out keeps the stored one and
 * a blank `username` removes the credentials. `build` saves the build settings in the same request.
 * An upload arrives through `/source/upload`: this form only changes its build path.
 */
export const saveSourceRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("image").optional(),
    image: imageReference,
    username: z.string().trim().max(256, "This is too long").optional(),
    password: z.string().max(4096, "This is too long").optional(),
  }),
  z.object({
    type: z.literal("github"),
    repository: githubRepository,
    ref: gitRef,
    path: buildPath,
    build: buildField,
  }),
  z.object({
    type: z.literal("git"),
    url: gitRemoteUrl,
    ref: gitRef,
    path: buildPath,
    build: buildField,
  }),
  z.object({
    type: z.literal("dockerfile"),
    dockerfile: z
      .string()
      .max(MAX_DOCKERFILE_CHARS, "This is too long")
      .refine((value) => value.trim() !== "", "Required"),
  }),
  z.object({
    type: z.literal("upload"),
    path: buildPath,
    build: buildField,
  }),
]);
export type SaveSourceRequest = z.infer<typeof saveSourceRequest>;

/** PUT /api/v1/projects/{project}/services/{service}/source/build. Null goes back to detection. */
export const saveBuildRequest = z.object({ build: buildConfig.nullable() });
export type SaveBuildRequest = z.infer<typeof saveBuildRequest>;

export const saveBuildResponse = z.object({ build: buildConfig.nullable() });

/** PUT /api/v1/projects/{project}/services/{service}/source/upload. The body is the archive itself. */
export const uploadSourceQuery = z.object({
  fileName: z
    .string()
    .min(1, "Required")
    .max(255, "This is too long")
    .refine(isSupportedArchiveName, "Use a zip, tar, 7z or rar archive"),
  path: buildPath.default("/"),
});
export type UploadSourceQuery = z.infer<typeof uploadSourceQuery>;

/** POST /api/v1/projects/{project}/services/{service}/source/ssh-key */
export const sshKeyResponse = z.object({ publicKey: z.string() });
export type SshKeyResponse = z.infer<typeof sshKeyResponse>;

/** POST /api/v1/projects/{project}/services/{service}/source/ssh-key/test */
export const sshKeyTestResult = z.object({
  ok: z.boolean(),
  /** Git's own words when it failed, with secrets removed. */
  detail: z.string(),
});
export type SshKeyTestResult = z.infer<typeof sshKeyTestResult>;

/** PUT /api/v1/projects/{project}/services/{service}/source/auto-deploy */
export const autoDeployRequest = z.object({ enabled: z.boolean() });
export type AutoDeployRequest = z.infer<typeof autoDeployRequest>;

/** GET /api/v1/projects/{project}/services/{service}/source/env-file */
export const envFileSettings = z.object({
  /** Null when no variables are written to a file. */
  path: envFilePath.nullable(),
  /**
   * True writes the file into the build context, where a `COPY` puts it in an image layer. False keeps
   * it out of the context altogether, and a Dockerfile reads it as the build secret `env-file`.
   */
  inImage: z.boolean(),
});
export type EnvFileSettings = z.infer<typeof envFileSettings>;

/** PUT .../source/env-file. Turning the file on has to say where it goes: nothing assumes that for you. */
export const saveEnvFileRequest = z
  .object({ path: envFilePath.nullable(), inImage: z.boolean().optional() })
  .refine((request) => request.path === null || request.inImage !== undefined, {
    path: ["inImage"],
    message: "Say whether this file may enter the image",
  });
export type SaveEnvFileRequest = z.infer<typeof saveEnvFileRequest>;
