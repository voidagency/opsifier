import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import { createApp, features } from "./app";
import { ActionEngine } from "./core/actions";
import { type AuthLimits, defaultAuthLimits, purgeExpiredSessions, RateLimiter } from "./core/auth";
import { type Config, ConfigError } from "./core/config";
import type { ApiApp, AppDeps } from "./core/context";
import { lockDataDirectory, openDatabase, StorageHealth } from "./core/db";
import { users } from "./core/db/schema";
import {
  createDockerDriver,
  type DockerDriver,
  defaultRolloutTiming,
  FakeDriver,
  type RolloutTiming,
  refuseOnUnsupportedEngine,
} from "./core/docker";
import { createLogger } from "./core/logger";
import { ProxyFiles } from "./core/proxy";
import { RealtimeHub } from "./core/realtime";
import { createSecrets, type Secrets } from "./core/secrets";
import { createTools, FakeTools, type ToolRunner } from "./core/tools";
import { addressCertificatesGuard } from "./features/opsifier-address/certificates";
import { restoreInterruptedUpdate } from "./features/panel-update/journal";
import { protectionGuard } from "./features/server-purpose/service";
import { sealStoredVariables } from "./features/services/env-store";
import { actionRedactor } from "./features/services/masking";

export interface RuntimeOverrides {
  docker?: DockerDriver;
  logger?: Logger;
  now?: () => number;
  authLimits?: AuthLimits;
  rollout?: RolloutTiming;
  tools?: ToolRunner;
  /** Only for a test standing in for a panel that has died, whose lock the kernel would have let go of. */
  lockDataDirectory?: typeof lockDataDirectory;
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
  // Before anything else touches the directory, so that a second panel changes nothing at all.
  const releaseDataDirectory = (overrides.lockDataDirectory ?? lockDataDirectory)(config.dataDir);
  try {
    return assembleRuntime(config, overrides, releaseDataDirectory);
  } catch (error) {
    releaseDataDirectory();
    throw error;
  }
}

function assembleRuntime(
  config: Config,
  overrides: RuntimeOverrides,
  releaseDataDirectory: () => void,
): Runtime {
  const logger = overrides.logger ?? createLogger(config);
  const now = overrides.now ?? Date.now;
  restoreInterruptedUpdate(config, logger);
  const database = openDatabase(config.databaseFile);

  let secrets: Secrets;
  try {
    const hasUsers = database.db.select({ id: users.id }).from(users).limit(1).get() !== undefined;
    secrets = createSecrets(config.secretKeyFile, { allowCreate: !hasUsers });
  } catch (error) {
    database.close();
    throw error;
  }

  const storage = new StorageHealth({ client: database.db.$client, dataDir: config.dataDir, logger, now });
  const realtime = new RealtimeHub({ db: database.db, config, logger, now });
  const docker = refuseOnUnsupportedEngine(overrides.docker ?? createDockerDriver(config));
  const deps: AppDeps = {
    config,
    logger,
    db: database.db,
    storage,
    secrets,
    docker,
    proxy: new ProxyFiles(
      config.traefikDynamicDir,
      addressCertificatesGuard(database.db, config.namesUrl !== null, protectionGuard(database.db, now)),
    ),
    realtime,
    actions: new ActionEngine({
      db: database.db,
      actionsDir: config.actionsDir,
      publisher: realtime,
      logger,
      storage,
      now,
      simulated: docker.kind === "fake",
    }),
    tools: overrides.tools ?? createTools(config),
    rollout: overrides.rollout ?? defaultRolloutTiming,
    rateLimiter: new RateLimiter(now),
    authLimits: overrides.authLimits ?? defaultAuthLimits,
    now,
  };
  deps.actions.redactWith((scope) => actionRedactor(deps, scope));

  if (deps.tools instanceof FakeTools && deps.docker instanceof FakeDriver) {
    const docker = deps.docker;
    deps.tools.onImageBuilt = (image, labels) => docker.addBuiltImage(image, labels);
  }

  return {
    deps,
    app: createApp(deps),

    async boot() {
      if (config.webDir !== undefined && !existsSync(join(config.webDir, "index.html"))) {
        throw new ConfigError(`OPSIFIER_WEB_DIR has no index.html: ${config.webDir}`);
      }
      sealStoredVariables(deps);
      deps.actions.recover();
      await deps.actions.startRetention();
      // A panel that cannot reach Docker must not pretend otherwise: the orchestrator restarts it.
      await deps.docker.ping();
      purgeExpiredSessions(deps.db, now());
      await deps.proxy.writeBase({ panelUpstream: config.panelUpstream });
      for (const feature of features) {
        await feature.boot?.(deps);
      }
      for (const feature of features) {
        await feature.ready?.(deps);
      }
    },

    async close() {
      for (const feature of features) {
        await feature.shutdown?.(deps);
      }
      await deps.actions.stop();
      realtime.close();
      await deps.docker.dispose();
      storage.stop();
      database.close();
      releaseDataDirectory();
    },
  };
}
