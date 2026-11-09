import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { McpServer } from "./server";

/**
 * MCP's stdio transport: one JSON-RPC message per line in each direction. Standard output belongs to
 * the protocol alone, so anything meant for a person goes to standard error.
 */
export async function serveStdio(server: McpServer, input: Readable, output: Writable): Promise<void> {
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    // Not awaited: a client may have several calls open, and a slow one must not hold up the next.
    const answering = server.handleLine(line).then((answer) => {
      if (answer !== null) {
        output.write(`${JSON.stringify(answer)}\n`);
      }
    });
    pending.add(answering);
    void answering.finally(() => pending.delete(answering));
  }
  await Promise.all(pending);
}
