import type { HttpBindings } from "@hono/node-server";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Logger } from "pino";
import type { ActionEngine } from "./actions";
import type { AuthLimits, Principal, RateLimiter } from "./auth";
import type { Config } from "./config";
import type { Db, StorageHealth } from "./db";
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
  /** Whether the panel can still write its state. Changes stop when it can't. */
  storage: StorageHealth;
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
  /** For routes whose Authorization header is a credential of their own, not an API key. */
  readsOwnBearer?(path: string): boolean;
  /** For routes that read a body larger than the API's limit and enforce their own. */
  readsOwnBody?(path: string): boolean;
  /** Runs once during startup, before the server accepts requests. */
  boot?(deps: AppDeps): void | Promise<void>;
  /**
   * Runs once every feature has booted, for work that needs the whole panel in shape, such as
   * deployments: some features tidy or upgrade what deployments use while they boot.
   */
  ready?(deps: AppDeps): void | Promise<void>;
  /** Stops what `boot` started. Runs before Docker and the database are released. */
  shutdown?(deps: AppDeps): void | Promise<void>;
  register(app: ApiApp, deps: AppDeps): void;
}
