import {
  type LocalizedText,
  type TemplateDocument,
  type TemplateParam,
  type TemplateService,
  templateTokens,
} from "@opsifier/contract";
import { databaseAddress } from "./references";

/** What a service in the document turned into, once its name and address are known. */
export interface ServiceIdentity {
  kind: TemplateService["kind"];
  name: string;
  /** The primary domain, or null. */
  domain: string | null;
  /** Whether the domain is reached over HTTPS. */
  https: boolean;
  /** For a database: what its clients need. */
  database: { port: number; user: string; databaseName: string | null } | null;
}

export interface RenderInput {
  document: TemplateDocument;
  project: string;
  /** The base name services are published under, or the server's address. */
  serverHost: string | null;
  /** Non-secret values the person chose, by key. */
  params: Readonly<Record<string, string>>;
  services: ReadonlyMap<string, ServiceIdentity>;
}

/** The service whose environment is being written, so its own domain can follow the primary one. */
type RenderTarget = string | null;

const SEALED_DATABASE_ATTRIBUTES = new Set(["password", "passwordEncoded", "url", "rootPassword"]);

function requireIdentity(input: RenderInput, key: string): ServiceIdentity {
  const identity = input.services.get(key);
  if (identity === undefined) {
    throw new Error(`Unknown service: ${key}`);
  }
  return identity;
}

function databaseAttribute(identity: ServiceIdentity, key: string, attribute: string): string {
  if (identity.database === null) {
    throw new Error(`${key} is not a database`);
  }
  switch (attribute) {
    case "port":
      return String(identity.database.port);
    case "user":
      return identity.database.user;
    case "database":
      return identity.database.databaseName ?? "";
    default:
      throw new Error(`Unknown attribute: ${attribute}`);
  }
}

/**
 * What one token becomes. Anything sealed turns into a reference the deploy resolves, so no plain-text
 * configuration ever contains it, and a service's own domain follows whichever domain is primary.
 */
function renderToken(token: string, input: RenderInput, self: RenderTarget): string {
  if (token === "project") {
    return input.project;
  }
  if (token === "server.host") {
    return input.serverHost ?? "";
  }
  const [root, key = "", attribute = ""] = token.split(".");
  if (root === "params") {
    const param = input.document.params.find((candidate) => candidate.key === key);
    return param?.type === "secret" ? `$(secret.${key})` : (input.params[key] ?? "");
  }
  if (root === "secrets") {
    return `$(secret.${key})`;
  }
  const identity = requireIdentity(input, key);
  if (identity.database !== null && SEALED_DATABASE_ATTRIBUTES.has(attribute)) {
    return `$(db.${key}.${attribute})`;
  }
  switch (attribute) {
    case "name":
      return identity.name;
    case "host":
      return databaseAddress(input.project, identity.name);
    case "domain":
      return key === self ? "$(PRIMARY_DOMAIN)" : (identity.domain ?? "");
    case "url": {
      const host = key === self ? "$(PRIMARY_DOMAIN)" : (identity.domain ?? "");
      return `${identity.https ? "https" : "http"}://${host}`;
    }
    default:
      return databaseAttribute(identity, key, attribute);
  }
}

/** Replaces every `{{...}}` in a piece of text. */
export function renderText(text: string, input: RenderInput, self: RenderTarget = null): string {
  return text.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_, token: string) => renderToken(token, input, self));
}

/** The keys of the secrets and databases an environment refers to, for the service to carry. */
export function referencesOf(values: readonly string[]): { secrets: Set<string>; databases: Set<string> } {
  const secrets = new Set<string>();
  const databases = new Set<string>();
  for (const value of values) {
    for (const token of templateTokens(value)) {
      const [root, key = ""] = token.split(".");
      if (root === "secrets") {
        secrets.add(key);
      } else if (root === "params") {
        secrets.add(`param:${key}`);
      } else if (root === "services") {
        databases.add(key);
      }
    }
  }
  return { secrets, databases };
}

/** The environment of a service as dotenv text, one `KEY=value` per line. */
export function renderEnv(
  env: Readonly<Record<string, string>>,
  input: RenderInput,
  self: RenderTarget,
): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${renderText(value, input, self)}`)
    .join("\n");
}

/** A parameter's final text, or a reason it can't be used. Empty is only allowed when it is optional. */
export function resolveParam(param: TemplateParam, raw: unknown): { value: string; problem: string | null } {
  if (raw === undefined || raw === null || raw === "") {
    return { value: "", problem: param.required ? "Required" : null };
  }
  const text = String(raw);
  if (typeof raw === "string" && /[\r\n]/.test(raw)) {
    return { value: "", problem: "Must fit on one line" };
  }
  switch (param.type) {
    case "number":
      return Number.isFinite(Number(text))
        ? { value: text, problem: null }
        : { value: "", problem: "Must be a number" };
    case "boolean":
      return { value: text === "true" ? "true" : "false", problem: null };
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)
        ? { value: text, problem: null }
        : { value: "", problem: "Enter an email address" };
    case "url":
      return /^https?:\/\/\S+$/.test(text)
        ? { value: text, problem: null }
        : { value: "", problem: "Enter a full address starting with http:// or https://" };
    case "select":
      return (param.options ?? []).some((option) => option.value === text)
        ? { value: text, problem: null }
        : { value: "", problem: "Choose one of the options" };
    default:
      return { value: text, problem: null };
  }
}

export type InstructionsText = LocalizedText | null;

/** The instructions, in both languages, with the names now known. */
export function renderInstructions(input: RenderInput): InstructionsText {
  const { instructions } = input.document;
  if (instructions === undefined) {
    return null;
  }
  return { en: renderText(instructions.en, input), fr: renderText(instructions.fr, input) };
}
