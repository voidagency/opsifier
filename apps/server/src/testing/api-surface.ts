/**
 * The public API reduced to what a client relies on, one fact per line, so that a change to it is a
 * readable diff: operations, their inputs and every field of their answers, with their types and
 * whether they are required. Descriptions, patterns and limits are left out on purpose: tightening
 * those is judged elsewhere, and rewording them changes nothing for a client.
 */

type Schema = Record<string, unknown>;

interface Operation {
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: Schema }>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
}

export interface ApiDocument {
  paths: Record<string, Record<string, Operation>>;
}

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const MAX_DEPTH = 24;

function typeOf(schema: Schema): string {
  if (Array.isArray(schema.enum)) {
    return `enum(${[...schema.enum].map(String).sort().join("|")})`;
  }
  if (schema.const !== undefined) {
    return `const(${String(schema.const)})`;
  }
  if (Array.isArray(schema.type)) {
    return [...schema.type].sort().join("|");
  }
  return typeof schema.type === "string" ? schema.type : "any";
}

/** Every leaf of a schema, as `path: type`. A `!` marks a property the schema requires. */
function leaves(schema: Schema | undefined, prefix: string, depth = 0): string[] {
  if (schema === undefined || depth > MAX_DEPTH) {
    return [];
  }
  const variants = ["oneOf", "anyOf", "allOf"].flatMap((key) => (schema[key] as Schema[] | undefined) ?? []);
  const properties = schema.properties as Record<string, Schema> | undefined;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  if (variants.length > 0) {
    return variants.flatMap((variant) => leaves(variant, prefix, depth + 1));
  }
  if (properties !== undefined) {
    return Object.entries(properties).flatMap(([name, value]) =>
      leaves(value, `${prefix === "" ? "" : `${prefix}.`}${name}${required.has(name) ? "!" : ""}`, depth + 1),
    );
  }
  if (schema.type === "array") {
    return leaves(schema.items as Schema | undefined, `${prefix}[]`, depth + 1);
  }
  return [`${prefix === "" ? "<root>" : prefix}: ${typeOf(schema)}`];
}

function surfaceOfOperation(operation: Operation): string[] {
  const inputs = (operation.parameters ?? [])
    .filter((parameter) => parameter.in === "path" || parameter.in === "query")
    .map(
      (parameter) =>
        `${parameter.in} ${parameter.name}${parameter.required === true ? "!" : ""}: ${typeOf(parameter.schema ?? {})}`,
    );
  const body = leaves(operation.requestBody?.content?.["application/json"]?.schema, "").map(
    (leaf) => `body ${leaf}`,
  );
  // Every error has the same shape, so an error status only needs to say that it can happen.
  const responses = Object.entries(operation.responses ?? {}).flatMap(([status, response]) => {
    const schema = response.content?.["application/json"]?.schema;
    return schema === undefined || Number(status) >= 400
      ? [status]
      : leaves(schema, "").map((leaf) => `${status} ${leaf}`);
  });
  return [...new Set([...inputs, ...body, ...responses])].sort();
}

/** The surface as text: each operation on its own line, each fact about it indented below. */
export function surfaceLines(document: ApiDocument): string[] {
  const lines: string[] = [];
  for (const path of Object.keys(document.paths).sort()) {
    const item = document.paths[path] as Record<string, Operation>;
    for (const method of Object.keys(item)
      .filter((key) => METHODS.has(key))
      .sort()) {
      lines.push(`${method.toUpperCase()} ${path}`);
      for (const fact of surfaceOfOperation(item[method] as Operation)) {
        lines.push(`  ${fact}`);
      }
    }
  }
  return lines;
}

/** Facts keyed by their operation, the comparable form of {@link surfaceLines}. */
function factsOf(lines: readonly string[]): Set<string> {
  const facts = new Set<string>();
  let operation = "";
  for (const line of lines) {
    if (line.startsWith("  ")) {
      facts.add(`${operation}\n${line.trim()}`);
    } else {
      operation = line;
      facts.add(line);
    }
  }
  return facts;
}

/** True for an input every client would have to start sending: required all the way down. */
function isNewRequirement(fact: string): boolean {
  const [where, path] = fact.split(" ");
  return (
    (where === "path" || where === "query" || where === "body") &&
    path !== undefined &&
    path
      .split(":")[0]
      ?.split(".")
      .every((segment) => segment.replace("[]", "").endsWith("!")) === true
  );
}

export interface SurfaceDiff {
  /** Things clients can rely on that are gone or have changed. */
  breaking: string[];
  additions: string[];
}

export function diffSurfaces(baseline: readonly string[], current: readonly string[]): SurfaceDiff {
  const before = factsOf(baseline);
  const after = factsOf(current);
  const operationsAfter = new Set(current.filter((line) => !line.startsWith("  ")));
  const operationsBefore = new Set(baseline.filter((line) => !line.startsWith("  ")));
  const breaking: string[] = [];
  const additions: string[] = [];
  const display = (fact: string) => fact.replace("\n", "  ");

  for (const fact of before) {
    const operation = fact.split("\n")[0] as string;
    if (!after.has(fact) && (operationsAfter.has(operation) || fact === operation)) {
      breaking.push(display(fact));
    }
  }
  for (const fact of after) {
    if (before.has(fact)) {
      continue;
    }
    const [operation, detail] = fact.split("\n") as [string, string | undefined];
    const newRequirement =
      detail !== undefined && operationsBefore.has(operation) && isNewRequirement(detail);
    (newRequirement ? breaking : additions).push(display(fact));
  }
  return { breaking: breaking.sort(), additions: additions.sort() };
}
