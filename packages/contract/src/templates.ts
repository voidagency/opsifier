import { z } from "zod";
import { resourceName } from "./common";
import { MAX_COMPOSE_CHARS } from "./compose";
import { databaseEngine } from "./databases";
import { routePath } from "./service-tabs/domains";
import { buildConfig, buildPath, gitRef, gitRemoteUrl, imageReference } from "./service-tabs/source";
import { isCleanAbsolutePath } from "./service-tabs/storage";
import { serviceSummary } from "./services";

/**
 * The template format: one JSON document, the same shape in the `templates/` catalogue and in the
 * Create-from-schema dialog. It is strict on purpose. A document can only describe services inside
 * the project it is installed into: no project name, no host path and no unknown field gets through.
 */

export const MAX_TEMPLATE_SCHEMA_CHARS = 256 * 1024;
const MAX_SERVICES = 8;
const MAX_PARAMS = 32;
const MAX_SECRETS = 16;
const MAX_ENV_VALUE_CHARS = 8 * 1024;
const MAX_FILE_CHARS = 64 * 1024;

/** Each one is drawn as a pictogram, so a template needs no logo of its own. */
export const templateCategories = [
  "monitoring",
  "development",
  "data",
  "documents",
  "productivity",
  "communication",
  "media",
  "automation",
  "security",
  "infrastructure",
] as const;
export const templateCategory = z.enum(templateCategories);
export type TemplateCategory = z.infer<typeof templateCategory>;

const hasControlCharacter = (value: string): boolean =>
  [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

/** Text a person reads, in both languages the interface ships. */
const localized = (max: number) =>
  z
    .object({
      en: z.string().trim().min(1, "Required").max(max),
      fr: z.string().trim().min(1, "Required").max(max),
    })
    .strict();
export const localizedText = localized(20_000);
export type LocalizedText = z.infer<typeof localizedText>;

const templateId = z
  .string()
  .min(2, "Required")
  .max(40, "Must be at most 40 characters")
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Use lowercase letters, digits and dashes");

/** How other fields of the document refer to a service, a parameter or a secret. */
const documentKey = z
  .string()
  .min(1, "Required")
  .max(40, "Must be at most 40 characters")
  .regex(/^[a-zA-Z][a-zA-Z0-9]*$/, "Use letters and digits, starting with a letter");

const semanticVersion = z.string().regex(/^\d+\.\d+\.\d+$/, "Use a version such as 1.0.0");

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** The tag or digest an image reference names, if it names one. */
function imageTag(reference: string): string | null {
  if (reference.includes("@sha256:")) {
    return reference.slice(reference.indexOf("@") + 1);
  }
  const last = reference.split("/").at(-1) ?? "";
  const colon = last.lastIndexOf(":");
  return colon === -1 ? null : last.slice(colon + 1);
}

/** `name:1.2.3` yes, `name` and `name:latest` no: an image that can move is not a pinned image. */
export function isPinnedImage(reference: string): boolean {
  const tag = imageTag(reference);
  return tag !== null && tag !== "latest";
}

export const pinnedImage = imageReference.refine(isPinnedImage, "Name an explicit version, not latest");

const containerPath = z
  .string()
  .min(1, "Required")
  .max(4096, "This is too long")
  .refine(isCleanAbsolutePath, "Use an absolute path such as /data, with no . or .. in it");

/** Anything a template declares on the file system stays inside what the panel manages. */
const templateMount = z.discriminatedUnion("type", [
  z.object({ type: z.literal("volume"), name: resourceName, path: containerPath }).strict(),
  z
    .object({
      type: z.literal("file"),
      path: containerPath,
      content: z.string().max(MAX_FILE_CHARS, "This is too long"),
    })
    .strict(),
  /** The only way a template can reach the host, and it has to be confirmed at install. */
  z.object({ type: z.literal("docker-socket"), path: containerPath }).strict(),
]);
export type TemplateMount = z.infer<typeof templateMount>;

const templateDomain = z
  .object({
    /** The port the container listens on. */
    port: z.number().int().min(1).max(65535),
    path: routePath.default("/"),
    https: z.boolean().default(true),
  })
  .strict();

const templatePort = z
  .object({
    protocol: z.enum(["tcp", "udp"]).default("tcp"),
    /** A number, or `{{params.<key>}}`. */
    published: z.union([z.number().int().min(1).max(65535), z.string().min(1).max(64)]),
    target: z.number().int().min(1).max(65535),
  })
  .strict();

/** How to tell the service is up: fetched through the proxy after its first deploy. */
const startupTest = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => value.startsWith("/"), "Must start with /"),
    /** The statuses that count as up. */
    expect: z
      .array(z.number().int().min(100).max(599))
      .min(1, "List at least one status")
      .max(8, "This is too many"),
  })
  .strict();

const envKeyString = z.string().regex(ENV_KEY, "Use letters, digits and underscores");

const templateEnv = z.record(
  envKeyString,
  z
    .string()
    .max(MAX_ENV_VALUE_CHARS, "This is too long")
    .refine((value) => !hasControlCharacter(value), "Must fit on one line"),
);

const serviceFields = {
  /** How the rest of the document refers to this service. */
  key: documentKey,
  /** What the service is called unless the person installing it says otherwise. */
  name: resourceName,
};

const dependsOn = z.array(documentKey).max(MAX_SERVICES).default([]);

const appSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("image"), image: pinnedImage }).strict(),
  z
    .object({
      type: z.literal("git"),
      url: gitRemoteUrl,
      ref: gitRef,
      path: buildPath.default("/"),
      build: buildConfig.nullable().default(null),
    })
    .strict(),
]);

const appService = z
  .object({
    ...serviceFields,
    kind: z.literal("app"),
    source: appSource,
    env: templateEnv.default({}),
    /** Replaces the image's command. It runs through the container's own shell. */
    command: z.string().trim().min(1).max(4096).nullable().default(null),
    mounts: z.array(templateMount).max(32).default([]),
    domain: templateDomain.nullable().default(null),
    ports: z.array(templatePort).max(16).default([]),
    startup: startupTest.nullable().default(null),
    dependsOn,
  })
  .strict();

const databaseService = z
  .object({
    ...serviceFields,
    kind: z.literal("database"),
    engine: databaseEngine,
    image: pinnedImage,
    /** The project name is used when this is left out. */
    databaseName: z
      .string()
      .max(63, "Must be at most 63 characters")
      .regex(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/, "Use letters, digits, dashes and underscores")
      .optional(),
    user: z
      .string()
      .max(32, "Must be at most 32 characters")
      .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "Use letters, digits, dashes, dots and underscores")
      .optional(),
  })
  .strict();

const composeService = z
  .object({
    ...serviceFields,
    kind: z.literal("compose"),
    /** The Compose file. Values that must stay secret go through `env` and `${VAR}`. */
    file: z.string().min(1, "Required").max(MAX_COMPOSE_CHARS, "This is too long"),
    env: templateEnv.default({}),
    domain: templateDomain
      .extend({ child: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "Name a service in the file") })
      .strict()
      .nullable()
      .default(null),
    startup: startupTest.nullable().default(null),
    dependsOn,
  })
  .strict();

const templateService = z.discriminatedUnion("kind", [appService, databaseService, composeService]);
export type TemplateService = z.infer<typeof templateService>;
export type TemplateAppService = z.infer<typeof appService>;
export type TemplateDatabaseService = z.infer<typeof databaseService>;
export type TemplateComposeService = z.infer<typeof composeService>;

export const templateParamTypes = ["text", "email", "url", "number", "boolean", "select", "secret"] as const;

const templateParam = z
  .object({
    key: documentKey,
    label: localized(80),
    help: localized(400).optional(),
    type: z.enum(templateParamTypes).default("text"),
    required: z.boolean().default(true),
    /** Pre-filled in the form. A `secret` with none is generated when left empty. */
    default: z.union([z.string().max(2048), z.number(), z.boolean()]).optional(),
    options: z
      .array(z.object({ value: z.string().min(1).max(128), label: localized(80) }).strict())
      .max(64)
      .optional(),
    /** How long a generated secret is, for a `secret` with no default. */
    generate: z
      .object({
        length: z.number().int().min(12).max(128).default(32),
        alphabet: z.enum(["alphanumeric", "hex"]).default("alphanumeric"),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TemplateParam = z.infer<typeof templateParam>;

const templateSecret = z
  .object({
    key: documentKey,
    length: z.number().int().min(16).max(128).default(32),
    alphabet: z.enum(["alphanumeric", "hex"]).default("alphanumeric"),
    /** Shown on the install page, for a secret someone needs to sign in with. */
    label: localized(80).optional(),
  })
  .strict();
export type TemplateSecret = z.infer<typeof templateSecret>;

const templateLink = z
  .object({
    kind: z.enum(["website", "docs", "source"]),
    url: z.url().refine((value) => value.startsWith("https://"), "Must start with https://"),
  })
  .strict();

const LOOSE_TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** The `{{...}}` tokens of a piece of text. */
export function templateTokens(text: string): string[] {
  return [...text.matchAll(LOOSE_TOKEN)].map((match) => match[1] ?? "");
}

const TOKEN_ATTRIBUTES: Record<TemplateService["kind"], readonly string[]> = {
  app: ["name", "host", "domain", "url"],
  compose: ["name", "domain", "url"],
  database: [
    "name",
    "host",
    "port",
    "user",
    "password",
    "passwordEncoded",
    "database",
    "url",
    "rootPassword",
  ],
};

/** Attributes that resolve to something sealed, so they may only be used where sealed values can go. */
const SEALED_ATTRIBUTES: ReadonlySet<string> = new Set([
  "password",
  "passwordEncoded",
  "url",
  "rootPassword",
]);

export interface TemplateTokenContext {
  params: ReadonlyMap<string, TemplateParam>;
  secrets: ReadonlySet<string>;
  services: ReadonlyMap<string, TemplateService>;
}

/**
 * Null when a token can be used here, or why not. Sealed values may only reach a container's
 * environment, where they are resolved at deploy time and never written down in plain text.
 */
export function explainTokenProblem(
  token: string,
  context: TemplateTokenContext,
  allowSealed: boolean,
): string | null {
  const sealedRefused = "Secrets can only be used in env values";
  if (token === "project" || token === "server.host") {
    return null;
  }
  const [root, key, attribute, ...rest] = token.split(".");
  if (root === "params" && key !== undefined && attribute === undefined) {
    const param = context.params.get(key);
    if (param === undefined) {
      return `Unknown parameter: ${key}`;
    }
    return param.type === "secret" && !allowSealed ? sealedRefused : null;
  }
  if (root === "secrets" && key !== undefined && attribute === undefined) {
    if (!context.secrets.has(key)) {
      return `Unknown secret: ${key}`;
    }
    return allowSealed ? null : sealedRefused;
  }
  if (root === "services" && key !== undefined && attribute !== undefined && rest.length === 0) {
    const service = context.services.get(key);
    if (service === undefined) {
      return `Unknown service: ${key}`;
    }
    if (!TOKEN_ATTRIBUTES[service.kind].includes(attribute)) {
      return `${key} has no ${attribute}`;
    }
    if (service.kind === "database" && SEALED_ATTRIBUTES.has(attribute) && !allowSealed) {
      return sealedRefused;
    }
    if (
      attribute === "rootPassword" &&
      service.kind === "database" &&
      !["mysql", "mariadb"].includes(service.engine)
    ) {
      return `${service.engine} has no root password`;
    }
    return null;
  }
  return `Unknown token: ${token}`;
}

/** Services with their dependencies before them. Throws on a cycle: the schema refuses those first. */
export function templateDeployOrder(services: readonly TemplateService[]): TemplateService[] {
  const byKey = new Map(services.map((service) => [service.key, service]));
  const done = new Set<string>();
  const ordered: TemplateService[] = [];
  const visit = (service: TemplateService, stack: readonly string[]) => {
    if (done.has(service.key)) {
      return;
    }
    if (stack.includes(service.key)) {
      throw new Error(`Dependency cycle through ${service.key}`);
    }
    const needs = service.kind === "database" ? [] : service.dependsOn;
    for (const key of needs) {
      const dependency = byKey.get(key);
      if (dependency !== undefined) {
        visit(dependency, [...stack, service.key]);
      }
    }
    done.add(service.key);
    ordered.push(service);
  };
  for (const service of services) {
    visit(service, []);
  }
  return ordered;
}

function findCycle(services: readonly TemplateService[]): string | null {
  try {
    templateDeployOrder(services);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Dependency cycle";
  }
}

const documentShape = z
  .object({
    id: templateId,
    /** Of this definition, not of the application it installs. */
    version: semanticVersion,
    name: z.string().trim().min(1, "Required").max(60, "Must be at most 60 characters"),
    summary: localized(160),
    description: localized(2000),
    /** Shown after creation, once the names are known. */
    instructions: localized(2000).optional(),
    category: templateCategory,
    tags: z
      .array(
        z
          .string()
          .max(30, "Must be at most 30 characters")
          .regex(/^[a-z0-9][a-z0-9-]*$/, "Use lowercase letters, digits and dashes"),
      )
      .max(12, "At most 12 tags")
      .default([]),
    links: z.array(templateLink).max(6, "At most 6 links").default([]),
    /** True only with a real fixture behind it: installed and checked, on real Docker. */
    verified: z.boolean().default(false),
    params: z.array(templateParam).max(MAX_PARAMS, "This is too many").default([]),
    secrets: z.array(templateSecret).max(MAX_SECRETS, "This is too many").default([]),
    services: z
      .array(templateService)
      .min(1, "List at least one service")
      .max(MAX_SERVICES, "This is too many"),
  })
  .strict();

type DocumentShape = z.infer<typeof documentShape>;

function duplicates(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

function checkTokens(text: string, context: TemplateTokenContext, allowSealed: boolean): string | null {
  for (const token of templateTokens(text)) {
    const problem = explainTokenProblem(token, context, allowSealed);
    if (problem !== null) {
      return problem;
    }
  }
  return null;
}

type Refinement = z.core.$RefinementCtx<DocumentShape>;

function checkReferences(document: DocumentShape, context: TemplateTokenContext, ctx: Refinement): void {
  const report = (path: PropertyKey[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const scan = (text: string | undefined, path: PropertyKey[], allowSealed: boolean) => {
    const problem = text === undefined ? null : checkTokens(text, context, allowSealed);
    if (problem !== null) {
      report(path, problem);
    }
  };

  if (document.instructions !== undefined) {
    scan(document.instructions.en, ["instructions", "en"], false);
    scan(document.instructions.fr, ["instructions", "fr"], false);
  }

  document.services.forEach((service, index) => {
    const at = (...rest: PropertyKey[]) => ["services", index, ...rest];
    if (service.kind === "database") {
      return;
    }

    for (const key of service.dependsOn) {
      if (!context.services.has(key)) {
        report(at("dependsOn"), `Unknown service: ${key}`);
      }
    }
    for (const [name, value] of Object.entries(service.env)) {
      scan(value, at("env", name), true);
      // A value that depends on a database needs that database deployed first.
      for (const token of templateTokens(value)) {
        const [root, key] = token.split(".");
        if (root === "services" && key !== undefined && key !== service.key) {
          const other = context.services.get(key);
          if (other?.kind === "database" && !service.dependsOn.includes(key)) {
            report(at("dependsOn"), `Add ${key} to dependsOn: ${name} needs it`);
          }
        }
      }
    }

    if (service.kind === "app") {
      if (service.domain !== null && service.startup === null) {
        report(at("startup"), "A service with a domain declares a start-up test");
      }
      scan(service.command ?? undefined, at("command"), false);
      service.mounts.forEach((mount, position) => {
        if (mount.type === "file") {
          scan(mount.content, at("mounts", position, "content"), false);
        }
      });
      service.ports.forEach((port, position) => {
        if (
          typeof port.published === "string" &&
          !/^\{\{\s*params\.[a-zA-Z0-9]+\s*\}\}$/.test(port.published)
        ) {
          report(at("ports", position, "published"), "Use a port number or a {{params.<key>}} token");
        }
      });
    } else {
      if (service.domain !== null && service.startup === null) {
        report(at("startup"), "A service with a domain declares a start-up test");
      }
      scan(service.file, at("file"), false);
    }
  });
}

/** Everything about a document that only shows when its parts are read together. */
function refineDocument(document: DocumentShape, ctx: Refinement): void {
  const report = (path: PropertyKey[], message: string) => ctx.addIssue({ code: "custom", path, message });

  for (const key of duplicates(document.services.map((service) => service.key))) {
    report(["services"], `Two services use the key ${key}`);
  }
  for (const name of duplicates(document.services.map((service) => service.name))) {
    report(["services"], `Two services use the name ${name}`);
  }
  for (const key of duplicates(document.params.map((param) => param.key))) {
    report(["params"], `Two parameters use the key ${key}`);
  }
  for (const key of duplicates(document.secrets.map((secret) => secret.key))) {
    report(["secrets"], `Two secrets use the key ${key}`);
  }

  document.params.forEach((param, index) => {
    if (param.type === "select" && (param.options ?? []).length === 0) {
      report(["params", index, "options"], "A select needs options");
    }
    if (param.type === "secret" && param.default !== undefined) {
      report(["params", index, "default"], "A secret has no default: leave it empty to generate one");
    }
  });

  if (document.services.every((service) => service.kind === "database")) {
    report(["services"], "List at least one app or compose service");
  }
  const cycle = findCycle(document.services);
  if (cycle !== null) {
    report(["services"], cycle);
    return;
  }

  checkReferences(
    document,
    {
      params: new Map(document.params.map((param) => [param.key, param])),
      secrets: new Set(document.secrets.map((secret) => secret.key)),
      services: new Map(document.services.map((service) => [service.key, service])),
    },
    ctx,
  );
}

/** One template, from the catalogue or pasted in. */
export const templateDocument = documentShape.superRefine(refineDocument);
export type TemplateDocument = z.infer<typeof templateDocument>;

/** Whether installing this document hands something the run of the server. */
export function requiresHostAccess(document: TemplateDocument): boolean {
  return document.services.some(
    (service) => service.kind === "app" && service.mounts.some((mount) => mount.type === "docker-socket"),
  );
}

/** GET /api/v1/templates: every template, for instant filtering in the browser. */
export const templateCatalogue = z.object({ templates: z.array(templateDocument) });
export type TemplateCatalogue = z.infer<typeof templateCatalogue>;

/** POST /api/v1/templates/preview */
export const templatePreviewRequest = z.object({
  schema: z.string().max(MAX_TEMPLATE_SCHEMA_CHARS, "This is too long"),
});
export type TemplatePreviewRequest = z.infer<typeof templatePreviewRequest>;

export const templateValue = z.union([z.string().max(4096), z.number(), z.boolean()]);
export type TemplateValue = z.infer<typeof templateValue>;

const installService = z
  .object({
    name: resourceName,
    /** An app or database image. Compose stacks name their images in the file. */
    image: pinnedImage.optional(),
    /** A database service already in this project, to use instead of creating one. */
    existing: resourceName.nullable().default(null),
  })
  .strict();

/** POST /api/v1/projects/{project}/templates */
export const installTemplateRequest = z
  .object({
    source: z.discriminatedUnion("type", [
      z.object({ type: z.literal("catalogue"), id: templateId }).strict(),
      z.object({ type: z.literal("schema"), schema: z.string().max(MAX_TEMPLATE_SCHEMA_CHARS) }).strict(),
    ]),
    services: z.record(documentKey, installService),
    params: z.record(documentKey, templateValue).default({}),
    /** Someone has read that this template can control the server. */
    acknowledgeHostAccess: z.boolean().default(false),
  })
  .strict();
export type InstallTemplateRequest = z.input<typeof installTemplateRequest>;
export type InstallTemplateFields = z.output<typeof installTemplateRequest>;

export const templateInstallPath = z.object({
  project: z.string(),
  install: z.string().min(1).max(32),
});

/** One service a template created, with where to find it. */
export const templateComponent = z.object({
  role: z.string(),
  kind: z.enum(["app", "database", "compose"]),
  service: serviceSummary,
  /** The primary URL. Null for a database, or a service with no domain. */
  url: z.string().nullable(),
});
export type TemplateComponent = z.infer<typeof templateComponent>;

export const templateInstallSecret = z.object({
  service: z.string(),
  name: z.string(),
  label: localizedText.nullable(),
});
export type TemplateInstallSecret = z.infer<typeof templateInstallSecret>;

export const templateInstall = z.object({
  id: z.string(),
  projectName: z.string(),
  templateId: z.string(),
  templateVersion: z.string(),
  templateName: z.string(),
  category: templateCategory,
  /** True when it was installed from a pasted document rather than the catalogue. */
  custom: z.boolean(),
  createdAt: z.iso.datetime(),
  instructions: localizedText.nullable(),
  components: z.array(templateComponent),
  secrets: z.array(templateInstallSecret),
});
export type TemplateInstall = z.infer<typeof templateInstall>;

/** GET /api/v1/projects/{project}/templates */
export const templateInstallList = z.object({ installs: z.array(templateInstall) });
export type TemplateInstallList = z.infer<typeof templateInstallList>;

/** POST /api/v1/projects/{project}/templates/{install}/deploy */
export const deployTemplateRequest = z.object({
  /** `pending` leaves alone what is already running, which is what makes a second try safe. */
  scope: z.enum(["pending", "all"]).default("pending"),
});
export type DeployTemplateRequest = z.input<typeof deployTemplateRequest>;

/** POST /api/v1/projects/{project}/templates/{install}/secrets/reveal */
export const revealTemplateSecretRequest = z.object({
  service: resourceName,
  name: documentKey,
});
export type RevealTemplateSecretRequest = z.infer<typeof revealTemplateSecretRequest>;

export const revealedTemplateSecret = z.object({ value: z.string() });
export type RevealedTemplateSecret = z.infer<typeof revealedTemplateSecret>;

/** Action types of template installs. */
export const templateActionTypes = {
  install: "template.install",
  deploy: "template.deploy",
  remove: "template.remove",
  reveal: "template.reveal",
} as const;
