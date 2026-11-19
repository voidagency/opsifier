import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_KEY_PLACEHOLDER, AGENT_SCRIPT, readAnswer } from "./agent";

const lines = (answer: unknown, size: number) => {
  const encoded = Buffer.from(JSON.stringify(answer)).toString("base64");
  return (encoded.match(new RegExp(`.{1,${size}}`, "g")) ?? []).map((piece) => `opsifier-studio ${piece}`);
};

describe("readAnswer", () => {
  it("puts back together an answer longer than a line of Docker's output, whatever else is printed", () => {
    const answer = { keyFound: true, answers: [{ status: 200, text: "x".repeat(200_000) }] };

    const output = ["a warning on stdout", ...lines(answer, 30_000), "opsifier-ok"].join("\n");

    expect(readAnswer(output)).toEqual({ keyFound: true, replies: answer.answers });
  });

  it("gives nothing for an answer that never came, or came broken", () => {
    expect(readAnswer("Traceback (most recent call last):\nopsifier-ok")).toBeNull();
    expect(readAnswer("opsifier-studio not-base64-json")).toBeNull();
  });
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!hasPython)("the script that calls the agent server", () => {
  const KEY = "agent-server-key-0123456789";
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  /** Runs the real script against a stand-in agent server, and gives back the bodies it received. */
  async function sent(body: unknown): Promise<unknown[]> {
    const received: unknown[] = [];
    server = createServer((request, response) => {
      let text = "";
      request.on("data", (chunk) => {
        text += chunk;
      });
      request.on("end", () => {
        received.push(JSON.parse(text));
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ id: "c0ffee00", title: null }));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const run = spawn("python3", ["-c", AGENT_SCRIPT], { env: { ...process.env, SESSION_API_KEY: KEY } });
    let output = "";
    run.stdout.on("data", (chunk) => {
      output += chunk;
    });
    run.stdin.end(
      JSON.stringify({
        url: `http://127.0.0.1:${port}`,
        placeholder: AGENT_KEY_PLACEHOLDER,
        calls: [{ method: "POST", path: "/api/conversations", body }],
      }),
    );
    await new Promise((resolve) => run.on("close", resolve));
    expect(output).toContain("opsifier-ok");
    return received;
  }

  it("puts the agent server's key in the secrets' headers, and nowhere a person wrote", async () => {
    const [body] = await sent({
      initial_message: {
        content: [{ type: "text", text: `Put this in the footer: ${AGENT_KEY_PLACEHOLDER}` }],
      },
      secrets: {
        GITHUB_TOKEN: { kind: "LookupSecret", headers: { "X-Session-API-Key": AGENT_KEY_PLACEHOLDER } },
      },
    });

    expect(body).toEqual({
      initial_message: {
        content: [{ type: "text", text: `Put this in the footer: ${AGENT_KEY_PLACEHOLDER}` }],
      },
      secrets: { GITHUB_TOKEN: { kind: "LookupSecret", headers: { "X-Session-API-Key": KEY } } },
    });
    expect(JSON.stringify(body).split(KEY)).toHaveLength(2);
  });
});
