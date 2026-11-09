import {
  cleanupChallenge,
  type Deps,
  disableServer,
  heartbeat,
  presentChallenge,
  Refusal,
  register,
  release,
  type SweepReport,
  sweep,
} from "./service";

const MAX_SECRET_LENGTH = 256;

/** The part of API Gateway's HTTP API payload (format 2.0) that this service reads. */
export interface HttpEvent {
  routeKey: string;
  headers?: Record<string, string | undefined>;
  pathParameters?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { sourceIp: string } };
}

export interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const respond = (statusCode: number, body: unknown, headers: Record<string, string> = {}): HttpResult => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  body: JSON.stringify(body),
});

function credentialsOf(event: HttpEvent): { id: string; secret: string } | null {
  const header = event.headers?.authorization;
  const [scheme, value] = header?.split(" ") ?? [];
  if (scheme?.toLowerCase() !== "basic" || value === undefined) {
    return null;
  }
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon === -1 || decoded.length - colon - 1 > MAX_SECRET_LENGTH) {
    return null;
  }
  return { id: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
}

function bodyOf(event: HttpEvent): string | undefined {
  if (event.body === undefined) {
    return undefined;
  }
  return event.isBase64Encoded === true ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

type Route = (event: HttpEvent, deps: Deps, sourceIp: string) => Promise<HttpResult>;

const routes: Record<string, Route> = {
  "POST /v1/servers": async (_event, deps, sourceIp) => respond(201, await register(deps, sourceIp)),

  "PUT /v1/servers/{id}": async (event, deps, sourceIp) =>
    respond(200, await heartbeat(deps, credentialsOf(event), event.pathParameters?.id, sourceIp)),

  "DELETE /v1/servers/{id}": async (event, deps) =>
    respond(200, await release(deps, credentialsOf(event), event.pathParameters?.id)),

  "POST /v1/acme/present": async (event, deps) => {
    await presentChallenge(deps, credentialsOf(event), bodyOf(event));
    return respond(200, { ok: true });
  },

  "POST /v1/acme/cleanup": async (event, deps) => {
    await cleanupChallenge(deps, credentialsOf(event), bodyOf(event));
    return respond(200, { ok: true });
  },
};

const challengeHeader = { "www-authenticate": 'Basic realm="opsifier-names"' };

function failureOf(error: unknown, deps: Deps, routeKey: string): HttpResult {
  if (error instanceof Refusal) {
    return respond(
      error.status,
      { error: { code: error.code, message: error.message } },
      error.status === 401 ? challengeHeader : {},
    );
  }
  deps.log("unexpected_error", { route: routeKey, error: error instanceof Error ? error.name : "unknown" });
  return respond(503, { error: { code: "unavailable", message: "The service could not complete this." } });
}

/**
 * The whole HTTP API. The address a server gets is the source of the connection as API Gateway saw it,
 * read in this one place and nowhere else: no header or body field can name a different one.
 */
export async function handle(event: HttpEvent, deps: Deps): Promise<HttpResult> {
  const started = deps.now();
  const route = routes[event.routeKey];
  const result =
    route === undefined
      ? respond(404, { error: { code: "not_found", message: "No such route." } })
      : await route(event, deps, event.requestContext.http.sourceIp).catch((error: unknown) =>
          failureOf(error, deps, event.routeKey),
        );
  deps.log("request", { route: event.routeKey, status: result.statusCode, ms: deps.now() - started });
  return result;
}

export type OperatorEvent = { action?: unknown; id?: unknown };

/** The schedule's event has no action, and an operator's says what to do. Nothing routes here over HTTP. */
export async function runMaintenance(
  event: OperatorEvent | undefined,
  deps: Deps,
): Promise<SweepReport | { id: string; status: "disabled" }> {
  if (event?.action === "disable") {
    return disableServer(deps, typeof event.id === "string" ? event.id : "");
  }
  const report = await sweep(deps);
  deps.log("sweep", { ...report });
  return report;
}
