import { serveStatic } from "@hono/node-server/serve-static";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { authenticate, originGuard, requireAuthentication, SESSION_COOKIE } from "./core/auth";
import type { ApiApp, AppDeps, AppEnv, Feature } from "./core/context";
import { createErrorHandler, errorBody, notFoundHandler, validationHook } from "./core/errors";
import { PROXY_PAGES_PREFIX } from "./core/proxy";
import * as featureModules from "./features";
import { authorizeRequests, guardPanelHost } from "./features/access/guard";
import { noindexPanelResponses } from "./features/server-purpose/routes";
import { requireTwoFactorSetup } from "./features/two-factor-policy/service";

const API_PREFIX = "/api/v1";
const OPENAPI_PATH = `${API_PREFIX}/openapi.json`;
const MAX_BODY_BYTES = 1024 * 1024;

export const features: Feature[] = Object.values(featureModules);

function logRequests(deps: Pick<AppDeps, "logger">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const startedAt = performance.now();
    await next();
    const entry = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - startedAt),
    };
    // The proxy's error pages answer 502, 503 and the like on purpose.
    if (c.res.status >= 500 && !c.req.path.startsWith(PROXY_PAGES_PREFIX)) {
      deps.logger.error(entry, "Request failed");
    } else {
      deps.logger.debug(entry, "Request");
    }
  };
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Stopping work in progress can only help, and it changes nothing the panel would have to save. */
const CANCEL_ACTION = /^\/api\/v1\/actions\/[^/]+\/cancel$/;

/** Once the panel has failed to save its state, it makes no further changes until that is fixed. */
function refuseChangesWhileStorageFails(deps: Pick<AppDeps, "storage">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (UNSAFE_METHODS.has(c.req.method) && !CANCEL_ACTION.test(c.req.path)) {
      deps.storage.assertWritable();
    }
    return next();
  };
}

function forbidCaching(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  };
}

function serveWebApp(app: ApiApp, webDir: string): void {
  const notApi: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.req.path.startsWith("/api/")) {
      return notFoundHandler(c);
    }
    return next();
  };

  app.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.ok) {
      // Vite puts a content hash in these names.
      c.header("Cache-Control", "public, max-age=31536000, immutable");
    }
  });
  app.use("*", notApi);
  app.use("*", serveStatic({ root: webDir }));
  // Anything else is a client-side route: answer with the app itself.
  const serveIndex = serveStatic<AppEnv>({ root: webDir, path: "index.html" });
  app.get("*", async (c, next) => {
    c.header("Cache-Control", "no-cache");
    return serveIndex(c, next);
  });
}

/** Builds the HTTP application. All wiring is explicit, so tests can build one in isolation. */
export function createApp(deps: AppDeps, featureList: Feature[] = features): ApiApp {
  const app: ApiApp = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

  const handleError = createErrorHandler(deps.logger);
  app.onError((error, c) => handleError(deps.storage.asAppError(error), c));
  app.notFound(notFoundHandler);

  app.use("*", logRequests(deps));
  app.use(
    "*",
    secureHeaders({
      // "no-referrer" would make browsers send `Origin: null` with our own mutations.
      referrerPolicy: "same-origin",
      // A panel on a bare IP cannot use HSTS, and a domain's policy belongs to its proxy.
      strictTransportSecurity: false,
      xFrameOptions: "DENY",
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // CodeMirror and Radix set styles at runtime.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  app.use("*", noindexPanelResponses(deps));
  app.use("*", guardPanelHost(deps));
  app.use(`${API_PREFIX}/*`, forbidCaching());
  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json(errorBody("payload_too_large", "The request body is too large."), 413),
  });
  app.use(`${API_PREFIX}/*`, (c, next) =>
    featureList.some((feature) => feature.readsOwnBody?.(c.req.path)) ? next() : limitBody(c, next),
  );

  const publicPaths = new Set([OPENAPI_PATH, ...featureList.flatMap((feature) => feature.publicPaths ?? [])]);
  app.use(
    `${API_PREFIX}/*`,
    authenticate(deps, (path) => featureList.some((feature) => feature.readsOwnBearer?.(path))),
  );
  app.use(`${API_PREFIX}/*`, originGuard(deps.config));
  const isPublic = (path: string) =>
    publicPaths.has(path) || featureList.some((feature) => feature.isPublicPath?.(path));
  app.use(`${API_PREFIX}/*`, requireAuthentication(isPublic));
  app.use(`${API_PREFIX}/*`, requireTwoFactorSetup(deps, isPublic));

  app.use(`${API_PREFIX}/*`, authorizeRequests(deps));
  app.use(`${API_PREFIX}/*`, refuseChangesWhileStorageFails(deps));

  for (const feature of featureList) {
    feature.register(app, deps);
  }

  app.openAPIRegistry.registerComponent("securitySchemes", "session", {
    type: "apiKey",
    in: "cookie",
    name: SESSION_COOKIE,
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "bearer", { type: "http", scheme: "bearer" });
  app.doc31(OPENAPI_PATH, {
    openapi: "3.1.0",
    info: {
      title: "Opsifier API",
      version: deps.config.version,
      description: `Realtime updates are carried by the WebSocket at ${API_PREFIX}/ws.`,
    },
    security: [{ session: [] }, { bearer: [] }],
  });

  if (deps.config.webDir !== undefined) {
    serveWebApp(app, deps.config.webDir);
  }

  return app;
}
