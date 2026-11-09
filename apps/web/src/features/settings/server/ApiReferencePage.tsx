import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { errorMessage } from "../../../lib/forms";
import { Badge, type BadgeTone, EmptyState, ErrorState, Input, MonoValue, Skeleton } from "../../../ui";

const DOCUMENT_PATH = "/openapi.json";

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: Schema;
}

interface MediaType {
  schema?: Schema;
}

interface ResponseSpec {
  description?: string;
}

interface Operation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, MediaType> };
  responses?: Record<string, ResponseSpec>;
}

interface Schema {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  additionalProperties?: boolean | Schema;
  description?: string;
  format?: string;
}

interface OpenApiDocument {
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
}

interface Row {
  method: string;
  path: string;
  operation: Operation;
}

const METHOD_ORDER = ["get", "post", "put", "patch", "delete"];

const methodTone: Record<string, BadgeTone> = {
  get: "neutral",
  post: "ok",
  put: "busy",
  patch: "busy",
  delete: "bad",
};

function resolve(document: OpenApiDocument, schema: Schema | undefined): Schema | undefined {
  if (schema?.$ref === undefined) {
    return schema;
  }
  return document.components?.schemas?.[schema.$ref.replace("#/components/schemas/", "")];
}

function typeOf(document: OpenApiDocument, schema: Schema | undefined): string {
  const target = resolve(document, schema);
  if (target === undefined) {
    return "any";
  }
  if (target.enum !== undefined) {
    return target.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (target.anyOf !== undefined || target.oneOf !== undefined) {
    return (target.anyOf ?? target.oneOf ?? []).map((option) => typeOf(document, option)).join(" | ");
  }
  if (target.type === "array") {
    return `${typeOf(document, target.items)}[]`;
  }
  return Array.isArray(target.type) ? target.type.join(" | ") : (target.type ?? "object");
}

function SchemaFields({
  document,
  schema,
  depth = 0,
}: {
  document: OpenApiDocument;
  schema: Schema | undefined;
  depth?: number;
}) {
  const target = resolve(document, schema);
  const fields = Object.entries(target?.properties ?? {});
  if (fields.length === 0 || depth > 3) {
    return <span className="font-mono text-xs text-muted">{typeOf(document, schema)}</span>;
  }
  return (
    <ul className="grid gap-1">
      {fields.map(([name, field]) => {
        const resolved = resolve(document, field);
        const required = target?.required?.includes(name) === true;
        const nested =
          resolved?.properties !== undefined
            ? resolved
            : resolved?.items !== undefined
              ? resolve(document, resolved.items)
              : undefined;
        return (
          <li key={name}>
            <span className="font-mono text-xs">
              {name}
              {required ? "" : "?"}: <span className="text-muted">{typeOf(document, field)}</span>
            </span>
            {nested?.properties !== undefined && (
              <div className="ml-3 mt-1 border-l pl-2">
                <SchemaFields document={document} schema={nested} depth={depth + 1} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function OperationCard({ document, row }: { document: OpenApiDocument; row: Row }) {
  const { t } = useTranslation("settings-api");
  const { operation } = row;
  const body = Object.values(operation.requestBody?.content ?? {})[0]?.schema;
  const params = operation.parameters ?? [];
  return (
    <li className="border-b py-3 last:border-b-0">
      <details>
        <summary className="flex cursor-pointer flex-wrap items-center gap-2">
          <Badge tone={methodTone[row.method] ?? "neutral"} mono>
            {row.method.toUpperCase()}
          </Badge>
          <MonoValue value={row.path} className="min-w-0 text-sm break-all" />
          <span className="text-sm text-muted">{operation.summary ?? ""}</span>
        </summary>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 pt-3 pl-1 text-sm break-words">
          {operation.description && <p className="text-muted">{operation.description}</p>}
          {params.length > 0 && (
            <div>
              <h4 className="eyebrow mb-1">{t("parameters")}</h4>
              <ul className="grid gap-1">
                {params.map((parameter) => (
                  <li key={`${parameter.in}:${parameter.name}`} className="font-mono text-xs">
                    {parameter.name}
                    {parameter.required ? "" : "?"}:{" "}
                    <span className="text-muted">{typeOf(document, parameter.schema)}</span>{" "}
                    <span className="text-muted">({parameter.in})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {body !== undefined && (
            <div>
              <h4 className="eyebrow mb-1">{t("body")}</h4>
              <SchemaFields document={document} schema={body} />
            </div>
          )}
          <div>
            <h4 className="eyebrow mb-1">{t("responses")}</h4>
            <ul className="grid gap-0.5">
              {Object.entries(operation.responses ?? {}).map(([status, response]) => (
                <li key={status} className="font-mono text-xs">
                  {status} <span className="text-muted">{response.description ?? ""}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>
    </li>
  );
}

/** The API, browsable: everything here comes from the same document the server validates against. */
export function ApiReferencePage() {
  const { t } = useTranslation(["settings-api", "common"]);
  const [search, setSearch] = useState("");
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["openapi"],
    queryFn: ({ signal }) => api.get<OpenApiDocument>(DOCUMENT_PATH, { signal }),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const sections = useMemo(() => {
    const groups = new Map<string, Row[]>();
    const needle = search.trim().toLowerCase();
    for (const [path, methods] of Object.entries(data?.paths ?? {})) {
      for (const method of METHOD_ORDER) {
        const operation = methods[method];
        if (operation === undefined) {
          continue;
        }
        const text = `${method} ${path} ${operation.summary ?? ""}`.toLowerCase();
        if (needle !== "" && !text.includes(needle)) {
          continue;
        }
        const tag = operation.tags?.[0] ?? t("untagged");
        groups.set(tag, [...(groups.get(tag) ?? []), { method, path, operation }]);
      }
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b));
  }, [data, search, t]);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 px-4 py-6 md:px-6 lg:px-8">
      <div>
        <h2 className="text-md font-medium">{t("title")}</h2>
        <p className="mt-1 max-w-[64ch] text-sm text-muted">{t("description")}</p>
        <pre className="mt-3 max-w-[64ch] rounded-sm bg-raised p-3 font-mono text-xs break-all whitespace-pre-wrap">
          {'curl -H "Authorization: Bearer $KEY" https://your-panel/api/v1/projects'}
        </pre>
        <p className="mt-2 text-sm">
          <Link to="/settings/user/api-keys" className="underline underline-offset-2">
            {t("manageKeys")}
          </Link>
          {" · "}
          <a href="/api/v1/openapi.json" className="font-mono text-xs underline underline-offset-2">
            openapi.json
          </a>
        </p>
      </div>
      <Input
        aria-label={t("search")}
        placeholder={t("search")}
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
        className="max-w-[530px]"
      />
      {isPending ? (
        <Skeleton className="h-64" />
      ) : isError ? (
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      ) : sections.length === 0 ? (
        <EmptyState illustration="not-found" title={t("noResults")} />
      ) : (
        sections.map(([tag, rows]) => (
          <section key={tag}>
            <h3 className="eyebrow border-b pb-1">{tag}</h3>
            <ul>
              {rows.map((row) => (
                <OperationCard key={`${row.method} ${row.path}`} document={data} row={row} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
