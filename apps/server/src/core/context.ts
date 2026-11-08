import type { HttpBindings } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Logger } from "pino";
import type { ActionEngine } from "./actions";
import type { AuthLimits, Principal, RateLimiter } from "./auth";
import type { Config } from "./config";
import type { Db } from "./db";
import type { DockerDriver, RolloutTiming } from "./docker";
import type { ProxyFiles } from "./proxy";
import type { RealtimeHub } from "./realtime";
import type { Secrets } from "./secrets";
import type { ToolRunner } from "./tools";

/** Everything a feature may use. Built once at boot and passed down explicitly. */
export interface AppDeps {
  config: Config;
  logger: Logger;
  db: Db;
  secrets: Secrets;
  docker: DockerDriver;
  proxy: ProxyFiles;
  realtime: RealtimeHub;
  actions: ActionEngine;
  /** Runs git and the image builders. */
  tools: ToolRunner;
  /** How closely and how long rollouts are watched. Shortened in tests. */
  rollout: RolloutTiming;
  rateLimiter: RateLimiter;
  authLimits: AuthLimits;
  now: () => number;
}

export type AppEnv = {
  Bindings: HttpBindings;
  Variables: {
    /** Null when the request carries no valid credential. Set by the authentication middleware. */
    principal: Principal | null;
  };
};

export type ApiApp = OpenAPIHono<AppEnv>;

/** What a feature module exports as `feature`. */
export interface Feature {
  /** Exact paths reachable without signing in. Everything else under the API requires it. */
  publicPaths?: readonly string[];
  /** For paths that carry a credential of their own, such as a deployment trigger. */
  isPublicPath?(path: string): boolean;
  /** For routes that read a body larger than the API's limit and enforce their own. */
  readsOwnBody?(path: string): boolean;
  /** Runs once during startup, before the server accepts requests. */
  boot?(deps: AppDeps): void | Promise<void>;
  register(app: ApiApp, deps: AppDeps): void;
}
