import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import { createApp, features } from "./app";
import { ActionEngine } from "./core/actions";
import { type AuthLimits, defaultAuthLimits, purgeExpiredSessions, RateLimiter } from "./core/auth";
import { type Config, ConfigError } from "./core/config";
import type { ApiApp, AppDeps } from "./core/context";
import { openDatabase } from "./core/db";
import { users } from "./core/db/schema";
import {
  createDockerDriver,
  type DockerDriver,
  defaultRolloutTiming,
  type RolloutTiming,
} from "./core/docker";
import { createLogger } from "./core/logger";
import { ProxyFiles } from "./core/proxy";
import { RealtimeHub } from "./core/realtime";
import { createSecrets, type Secrets } from "./core/secrets";
import { createTools, type ToolRunner } from "./core/tools";

export interface RuntimeOverrides {
  docker?: DockerDriver;
  logger?: Logger;
  now?: () => number;
  authLimits?: AuthLimits;
  rollout?: RolloutTiming;
  tools?: ToolRunner;
}

export interface Runtime {
  deps: AppDeps;
  app: ApiApp;
  /** Finishes startup. Throws if the panel cannot run, in which case it must not serve. */
  boot(): Promise<void>;
  /** Stops the work in progress and releases every resource, in dependency order. */
  close(): Promise<void>;
}

export function createRuntime(config: Config, overrides: RuntimeOverrides = {}): Runtime {
  const logger = overrides.logger ?? createLogger(config);
  const now = overrides.now ?? Date.now;
  const database = openDatabase(config.databaseFile);

  let secrets: Secrets;
  try {
    const hasUsers = database.db.select({ id: users.id }).from(users).limit(1).get() !== undefined;
    secrets = createSecrets(config.secretKeyFile, { allowCreate: !hasUsers });
  } catch (error) {
    database.close();
    throw error;
  }

  const realtime = new RealtimeHub({ db: database.db, config, logger, now });
  const deps: AppDeps = {
    config,
    logger,
    db: database.db,
    secrets,
    docker: overrides.docker ?? createDockerDriver(config),
    proxy: new ProxyFiles(config.traefikDynamicDir),
    realtime,
    actions: new ActionEngine({
      db: database.db,
      actionsDir: config.actionsDir,
      publisher: realtime,
      logger,
      now,
    }),
    tools: overrides.tools ?? createTools(config),
    rollout: overrides.rollout ?? defaultRolloutTiming,
    rateLimiter: new RateLimiter(now),
    authLimits: overrides.authLimits ?? defaultAuthLimits,
    now,
  };

  return {
    deps,
    app: createApp(deps),

    async boot() {
      if (config.webDir !== undefined && !existsSync(join(config.webDir, "index.html"))) {
        throw new ConfigError(`OPSIFIER_WEB_DIR has no index.html: ${config.webDir}`);
      }
      deps.actions.recover();
      await deps.actions.startRetention();
      // A panel that cannot reach Docker must not pretend otherwise: the orchestrator restarts it.
      await deps.docker.ping();
      purgeExpiredSessions(deps.db, now());
      await deps.proxy.writeBase({ panelUpstream: config.panelUpstream });
      for (const feature of features) {
        await feature.boot?.(deps);
      }
    },

    async close() {
      await deps.actions.stop();
      realtime.close();
      await deps.docker.dispose();
      database.close();
    },
  };
}
