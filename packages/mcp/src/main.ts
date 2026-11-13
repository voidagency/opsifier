import { ClientError, connectionFromEnv, hintFor, isExposedOnTheWire, PanelClient } from "@opsifier/client";
import pkg from "../package.json" with { type: "json" };
import { McpServer } from "./server";
import { serveStdio } from "./stdio";

function connect(): PanelClient {
  try {
    const connection = connectionFromEnv(process.env);
    if (isExposedOnTheWire(connection.url)) {
      console.error(
        `Warning: OPSIFIER_URL uses plain HTTP, so the API key can be read on the way to ${connection.url.host}.`,
      );
    }
    return new PanelClient(connection);
  } catch (error) {
    const hint = error instanceof ClientError ? hintFor(error) : undefined;
    console.error(`opsifier-mcp: ${(error as Error).message}${hint === undefined ? "" : ` ${hint}`}`);
    process.exit(1);
  }
}

/**
 * Whether the person who configured this server lets it stop, remove, restore or reveal anything.
 * Off unless they say so: the model writes every call, its confirmations included, but not this.
 */
const allowDestructive = ["1", "true", "yes"].includes(
  (process.env.OPSIFIER_MCP_ALLOW_DESTRUCTIVE ?? "").trim().toLowerCase(),
);

await serveStdio(new McpServer(connect(), pkg.version, { allowDestructive }), process.stdin, process.stdout);
