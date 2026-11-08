import { serve } from "@hono/node-server";
import type { Logger } from "pino";
import { ConfigError, loadConfig } from "./core/config";
import { createLogger } from "./core/logger";
import { SecretsError } from "./core/secrets";
import { createRuntime, type Runtime } from "./runtime";

const FORCED_EXIT_MS = 15_000;
/** Long enough to receive the largest upload the panel accepts over a slow connection. */
const REQUEST_TIMEOUT_MS = 60 * 60 * 1000;

function closeOnSignal(server: ReturnType<typeof serve>, runtime: Runtime, logger: Logger): void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) {
      process.exit(1);
    }
    closing = true;
    logger.info({ signal }, "Shutting down");

    const forced = setTimeout(() => process.exit(1), FORCED_EXIT_MS);
    forced.unref();

    // Open WebSockets count as connections: close() would otherwise wait for them forever.
    runtime.deps.realtime.close();
    server.close(() => {
      runtime
        .close()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          logger.error({ err: error }, "Shutdown failed");
          process.exit(1);
        });
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const runtime = createRuntime(config, { logger });
  await runtime.boot();

  const server = serve({ fetch: runtime.app.fetch, hostname: config.host, port: config.port }, (info) => {
    logger.info(
      {
        address: info.address,
        port: info.port,
        driver: config.driver,
        dataDir: config.dataDir,
        version: config.version,
      },
      "Opsifier is listening",
    );
  });
  server.on("error", (error) => {
    logger.fatal({ err: error }, "The server could not start");
    process.exit(1);
  });

  if ("requestTimeout" in server) {
    server.requestTimeout = REQUEST_TIMEOUT_MS;
  }

  runtime.deps.realtime.attach(server);
  closeOnSignal(server, runtime, logger);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof SecretsError) {
    console.error(error.message);
  } else {
    console.error("Opsifier could not start:", error);
  }
  process.exit(1);
});
