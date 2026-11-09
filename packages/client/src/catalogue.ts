import type { CallerIdentity } from "@opsifier/contract";
import { ROUTES } from "./api";
import { ClientError } from "./errors";
import type { PanelClient } from "./http";

export type OperationKind = "read" | "change" | "destructive";
export type OperationRisk = "low" | "medium" | "high";

/** Requests that cannot be taken back, or that take something offline. */
const DESTRUCTIVE_ENDING =
  /\/(?:stop|restore|discard-earlier-copy|resolve|rollback|reboot|disconnect|rotate)$|\/docker\/cleanup\/[^/]+$|\/(?:panel|proxy)\/restart$|\/system\/update$/;

/** Reads that can return a secret: an environment, a credential. */
const SENSITIVE_READ = /\/(?:env|environment|env-file|credentials|basic-auth)$/;

/** Works on a template or a filled-in path: a placeholder is never one of these endings. */
export function classifyOperation(
  method: string,
  path: string,
): { kind: OperationKind; risk: OperationRisk } {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") {
    return { kind: "read", risk: SENSITIVE_READ.test(path) ? "medium" : "low" };
  }
  if (verb === "DELETE" || DESTRUCTIVE_ENDING.test(path)) {
    return { kind: "destructive", risk: "high" };
  }
  return { kind: "change", risk: path.endsWith("/reveal") ? "high" : "medium" };
}

type Schema = Record<string, unknown>;

interface OpenApiOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: Schema; description?: string }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: Schema }> }>;
}

export interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
}

export interface CatalogueEntry {
  method: string;
  path: string;
  summary: string;
  group: string;
  kind: OperationKind;
  risk: OperationRisk;
  /** Which projects it is allowed in, when this caller doesn't reach every project. */
  projects: string[] | null;
}

/** Browser sign-in, CI triggers and OAuth pages: none of it means anything for an API key. */
const NOT_FOR_KEYS = /^\/api\/v1\/(?:auth\/(?!identity)|deploy(?:\/|$)|storage-providers\/oauth\/)/;

function summaryOf(operation: OpenApiOperation | undefined): string {
  return operation?.summary ?? operation?.description?.split(". ")[0] ?? "";
}

/** The operations this caller may call, as the panel itself says, described from its own document. */
export function buildCatalogue(document: OpenApiDocument, identity: CallerIdentity): CatalogueEntry[] {
  return identity.operations
    .filter(({ path }) => !NOT_FOR_KEYS.test(path))
    .map(({ method, path, projects }) => {
      const operation = document.paths[path]?.[method.toLowerCase()];
      return {
        method,
        path,
        summary: summaryOf(operation),
        group: operation?.tags?.[0] ?? "",
        ...classifyOperation(method, path),
        projects,
      };
    });
}

function matches(template: string, path: string): boolean {
  const expected = template.split("/");
  const actual = path.split("/");
  return (
    expected.length === actual.length &&
    expected.every((segment, index) => segment.startsWith("{") || segment === actual[index])
  );
}

/** What it takes to call one operation: its parameters and its body, straight from the document. */
export function describeOperation(document: OpenApiDocument, method: string, path: string) {
  const verb = method.toLowerCase();
  const template = Object.keys(document.paths).find(
    (candidate) => document.paths[candidate]?.[verb] !== undefined && matches(candidate, path),
  );
  const operation = template === undefined ? undefined : document.paths[template]?.[verb];
  if (template === undefined || operation === undefined) {
    throw new ClientError("not_found", `This panel has no operation ${method.toUpperCase()} ${path}.`, 404);
  }
  return {
    method: method.toUpperCase(),
    path: template,
    summary: summaryOf(operation),
    description: operation.description,
    ...classifyOperation(method, template),
    parameters: (operation.parameters ?? []).map(({ name, in: where, required, schema, description }) => ({
      name,
      in: where,
      required: required === true,
      schema,
      description,
    })),
    body: operation.requestBody?.content?.["application/json"]?.schema ?? null,
    bodyRequired: operation.requestBody?.required === true,
    responses: Object.fromEntries(
      Object.entries(operation.responses ?? {}).map(([status, response]) => [
        status,
        response.description ?? "",
      ]),
    ),
  };
}

/** The panel's own description of its API, which the catalogue is read from. */
export function fetchOpenApiDocument(client: PanelClient): Promise<OpenApiDocument> {
  return client.request<OpenApiDocument>(ROUTES.openapi.method, ROUTES.openapi.path);
}
