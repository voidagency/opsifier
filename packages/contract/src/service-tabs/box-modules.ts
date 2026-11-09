import { z } from "zod";

/**
 * The module matrix of a box: every runtime it can contain, and exactly what each version installs.
 * It is the one list. The server refuses anything that is not here, the interface offers nothing that
 * is not here, and a pin that moves here is what a server later reports as a security rebuild.
 */

/** Written into every build's record, so a rebuild can say which edition of this matrix it came from. */
export const BOX_MATRIX_REVISION = "2026.11";

/** One small distribution under every box, so that the layers beneath all of them are shared. */
export const BOX_BASE_IMAGE = "alpine:3.24.4";

export const boxModuleIds = ["node", "php", "python", "ruby", "nginx"] as const;
export type BoxModuleId = (typeof boxModuleIds)[number];

export interface BoxModuleVersion {
  /** What a person chooses. */
  version: string;
  /** Exactly what gets installed. A change to this with the same `version` is a security update. */
  pin: string;
}

export interface BoxExtension {
  id: string;
  /** The versions of its module it exists for. Absent means all of them. */
  onlyOn?: readonly string[];
}

export interface BoxModuleDefinition {
  id: BoxModuleId;
  versions: readonly BoxModuleVersion[];
  defaultVersion: string;
  extensions: readonly BoxExtension[];
}

export const boxMatrix: readonly BoxModuleDefinition[] = [
  {
    id: "node",
    versions: [
      { version: "22", pin: "node:22.23.4-alpine3.24" },
      { version: "24", pin: "node:24.22.2-alpine3.24" },
      { version: "26", pin: "node:26.13.0-alpine3.24" },
    ],
    defaultVersion: "24",
    extensions: [{ id: "pnpm" }, { id: "yarn" }],
  },
  {
    id: "php",
    versions: [
      { version: "8.3", pin: "php83 8.3.36" },
      { version: "8.4", pin: "php84 8.4.27" },
      { version: "8.5", pin: "php85 8.5.12" },
    ],
    defaultVersion: "8.4",
    extensions: [
      // PHP 8.5 has this built in, and has no package to add.
      { id: "opcache", onlyOn: ["8.3", "8.4"] },
      { id: "gd" },
      { id: "intl" },
      { id: "zip" },
      { id: "bcmath" },
      { id: "exif" },
      { id: "mysqli" },
      { id: "pdo_mysql" },
      { id: "pdo_pgsql" },
      { id: "pdo_sqlite" },
      { id: "redis" },
      { id: "imagick" },
      { id: "composer" },
    ],
  },
  {
    id: "python",
    versions: [
      { version: "3.13", pin: "python:3.13.18-alpine3.24" },
      { version: "3.14", pin: "python:3.14.10-alpine3.24" },
      { version: "3.15", pin: "python:3.15.2-alpine3.24" },
    ],
    defaultVersion: "3.14",
    extensions: [],
  },
  {
    id: "ruby",
    versions: [
      { version: "3.3", pin: "ruby:3.3.13-alpine3.24" },
      { version: "3.4", pin: "ruby:3.4.12-alpine3.24" },
      { version: "4.0", pin: "ruby:4.0.9-alpine3.24" },
    ],
    defaultVersion: "3.4",
    extensions: [],
  },
  {
    id: "nginx",
    versions: [{ version: "1.30", pin: "nginx 1.30.6" }],
    defaultVersion: "1.30",
    extensions: [],
  },
];

export function boxModule(id: BoxModuleId): BoxModuleDefinition {
  const definition = boxMatrix.find((module) => module.id === id);
  if (definition === undefined) {
    throw new Error(`The matrix has no module ${id}.`);
  }
  return definition;
}

const MAX_RELATIVE_PATH_CHARS = 1024;
const MAX_PATH_SEGMENTS = 64;

function hasForbiddenCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || value[index] === "\\") {
      return true;
    }
  }
  return false;
}

/**
 * A path inside a box's workspace in its one simple spelling: relative, with no `.`, `..`, empty
 * segment or control character. Nothing it says can leave the folder it is resolved in.
 */
export function isWorkspacePath(value: string): boolean {
  if (value === "" || value.length > MAX_RELATIVE_PATH_CHARS || hasForbiddenCharacter(value)) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.length <= MAX_PATH_SEGMENTS &&
    segments.every(
      (segment) => segment !== "" && segment !== "." && segment !== ".." && segment.length <= 255,
    )
  );
}

/** A folder of the workspace, where `.` is the workspace itself. */
export const workspaceFolder = z
  .string()
  .trim()
  .max(MAX_RELATIVE_PATH_CHARS, "This is too long")
  .refine(
    (value) => value === "." || isWorkspacePath(value),
    "Use a folder inside the workspace, such as public",
  );

const moduleChoice = z.object({
  version: z.string().min(1, "Required").max(16, "This is too long"),
  extensions: z.array(z.string().max(32, "This is too long")).max(32, "This is too many").default([]),
});
export type BoxModuleChoice = z.infer<typeof moduleChoice>;

const webServerChoice = z.object({
  /** Relative to the workspace. */
  documentRoot: workspaceFolder.default("public"),
});

/** What a box is set to contain. `null` means the module is off. */
export const boxModulesConfig = z.object({
  node: moduleChoice.nullable().default(null),
  php: moduleChoice.nullable().default(null),
  python: moduleChoice.nullable().default(null),
  ruby: moduleChoice.nullable().default(null),
  nginx: webServerChoice.nullable().default(null),
});
export type BoxModulesConfig = z.infer<typeof boxModulesConfig>;

export interface BoxModuleIssue {
  /** `php.extensions`, in the shape of the `fields` map of a 400. */
  field: string;
  message: string;
}

/** Why this selection can't be built. Empty when it can. The same check runs on save and before a build. */
export function boxModuleIssues(config: BoxModulesConfig): BoxModuleIssue[] {
  const issues: BoxModuleIssue[] = [];
  const runtimes: Array<[BoxModuleId, BoxModuleChoice | null]> = [
    ["node", config.node],
    ["php", config.php],
    ["python", config.python],
    ["ruby", config.ruby],
  ];
  for (const [id, choice] of runtimes) {
    if (choice === null) {
      continue;
    }
    const definition = boxModule(id);
    if (!definition.versions.some((candidate) => candidate.version === choice.version)) {
      issues.push({
        field: `${id}.version`,
        message: `This box can't run version ${choice.version}: it is not in the module matrix.`,
      });
      continue;
    }
    if (new Set(choice.extensions).size !== choice.extensions.length) {
      issues.push({ field: `${id}.extensions`, message: "Lists the same extension twice" });
    }
    for (const name of choice.extensions) {
      const extension = definition.extensions.find((candidate) => candidate.id === name);
      if (extension === undefined) {
        issues.push({
          field: `${id}.extensions`,
          message: `${name} is not available: it is not in the module matrix.`,
        });
      } else if (extension.onlyOn !== undefined && !extension.onlyOn.includes(choice.version)) {
        issues.push({
          field: `${id}.extensions`,
          message: `${name} can't be added to version ${choice.version}. It works with ${extension.onlyOn.join(", ")}.`,
        });
      }
    }
  }
  return issues;
}

export const saveBoxModulesRequest = boxModulesConfig;
export type SaveBoxModulesRequest = z.input<typeof saveBoxModulesRequest>;
