import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionFromEnv, isExposedOnTheWire } from "./connection";
import { ClientError } from "./errors";
import { normalizeApiPath, PanelClient } from "./http";

const servers: Server[] = [];

function listen(handler: RequestListener): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const KEY = "opsifier_secret-key-for-tests";
const clientFor = (url: string, send?: typeof fetch) =>
  new PanelClient({ url: new URL(url), apiKey: KEY }, send);

const failureOf = async (promise: Promise<unknown>): Promise<ClientError> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ClientError);
  return error as ClientError;
};

describe("a redirect", () => {
  it("is never followed to another host, and the key never reaches it", async () => {
    const seen: Array<string | undefined> = [];
    const elsewhere = await listen((request, response) => {
      seen.push(request.headers.authorization);
      response.end("{}");
    });
    const panel = await listen((_request, response) => {
      response.writeHead(302, { location: `${elsewhere}/api/v1/projects` }).end();
    });

    const error = await failureOf(clientFor(panel).request("GET", "/api/v1/projects"));

    expect(error.code).toBe("redirect_refused");
    expect(error.message).toContain(elsewhere);
    expect(seen).toEqual([]);
  });

  it("is refused the same for every method and every kind of redirect", async () => {
    const seen: string[] = [];
    const elsewhere = await listen((request, response) => {
      seen.push(request.method ?? "");
      response.end("{}");
    });
    for (const status of [301, 303, 307, 308]) {
      const panel = await listen((_request, response) => {
        response.writeHead(status, { location: elsewhere }).end();
      });
      const client = clientFor(panel);

      expect((await failureOf(client.request("POST", "/api/v1/x", { body: {} }))).code).toBe(
        "redirect_refused",
      );
      expect((await failureOf(client.request("DELETE", "/api/v1/x"))).code).toBe("redirect_refused");
    }
    expect(seen).toEqual([]);
  });

  it("is not followed even on the same host, so the key is only sent where it was told to go", async () => {
    let answered = 0;
    const panel = await listen((request, response) => {
      if (request.url === "/api/v1/start") {
        response.writeHead(302, { location: "/api/v1/end" }).end();
      } else {
        answered += 1;
        response.end("{}");
      }
    });

    expect((await failureOf(clientFor(panel).request("GET", "/api/v1/start"))).code).toBe("redirect_refused");
    expect(answered).toBe(0);
  });

  it("says where it went, without resending anything", async () => {
    const panel = await listen((_request, response) => {
      response.writeHead(308, { location: "https://elsewhere.example/api/v1/projects?token=abc" }).end();
    });

    const error = await failureOf(clientFor(panel).request("GET", "/api/v1/projects"));

    expect(error.message).toContain("https://elsewhere.example/api/v1/projects");
    expect(error.message).not.toContain("token=abc");
  });
});

describe("paths", () => {
  it.each([
    ["scheme-relative", "//elsewhere.example/api/v1/projects"],
    ["absolute", "https://elsewhere.example/api/v1/projects"],
    ["outside the API", "/admin"],
    ["climbing out", "/api/v1/../../admin"],
    ["climbing out, encoded", "/api/v1/%2e%2e/%2e%2e/admin"],
    ["with a backslash", "/api/v1/\\elsewhere.example"],
    ["with a query of its own", "/api/v1/projects?limit=1"],
    ["with an unfilled placeholder", "/api/v1/projects/{project}"],
    ["with a bad escape", "/api/v1/%zz"],
  ])("refuses one that is %s, without sending anything", async (_name, path) => {
    const send = vi.fn<typeof fetch>();

    const failure = clientFor("https://panel.example", send).request("GET", path);

    expect((await failureOf(failure)).code).toBe("invalid_path");
    expect(send).not.toHaveBeenCalled();
  });

  it("fills in a short form, so a path can be written as the reference writes it or more briefly", () => {
    expect(normalizeApiPath("/projects/shop")).toBe("/api/v1/projects/shop");
    expect(normalizeApiPath("projects/shop")).toBe("/api/v1/projects/shop");
    expect(normalizeApiPath("/api/v1/projects/shop")).toBe("/api/v1/projects/shop");
  });
});

describe("what comes back", () => {
  it("carries the bearer key and the JSON body in both directions", async () => {
    const received: Array<{ auth?: string; type?: string; body: string }> = [];
    const panel = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        received.push({
          auth: request.headers.authorization,
          type: request.headers["content-type"],
          body,
        });
        response.end(JSON.stringify({ ok: true }));
      });
    });

    await expect(clientFor(panel).request("POST", "/api/v1/things", { body: { a: 1 } })).resolves.toEqual({
      ok: true,
    });
    expect(received).toEqual([{ auth: `Bearer ${KEY}`, type: "application/json", body: '{"a":1}' }]);
  });

  it("keeps the panel's own code, message and fields", async () => {
    const panel = await listen((_request, response) => {
      response.statusCode = 400;
      response.end(
        JSON.stringify({ error: { code: "validation_failed", message: "No.", fields: { a: "Required" } } }),
      );
    });

    const error = await failureOf(clientFor(panel).request("GET", "/api/v1/x"));

    expect(error).toMatchObject({
      code: "validation_failed",
      message: "No.",
      status: 400,
      fields: { a: "Required" },
    });
  });

  it("says so when something that isn't the panel answers", async () => {
    const panel = await listen((_request, response) => {
      response.end("<html>not an API</html>");
    });

    expect((await failureOf(clientFor(panel).request("GET", "/api/v1/x"))).code).toBe("not_json");
  });

  it("reports a panel it cannot reach, without the key", async () => {
    const error = await failureOf(clientFor("http://127.0.0.1:1").request("GET", "/api/v1/x"));

    expect(error.code).toBe("unreachable");
    expect(error.message).not.toContain(KEY);
  });

  it("gives up on a panel that never answers", async () => {
    const panel = await listen(() => {
      // Accepts the request and says nothing.
    });

    const error = await failureOf(clientFor(panel).request("GET", "/api/v1/x", { timeoutMs: 20 }));

    expect(error.code).toBe("timeout");
  });
});

describe("configuration", () => {
  it("comes from the environment", () => {
    const connection = connectionFromEnv({ OPSIFIER_URL: "https://panel.example/", OPSIFIER_API_KEY: KEY });
    expect(connection.url.origin).toBe("https://panel.example");
    expect(connection.apiKey).toBe(KEY);
  });

  it("names what is missing", () => {
    expect(() => connectionFromEnv({})).toThrow(ClientError);
    expect(() => connectionFromEnv({ OPSIFIER_URL: "https://panel.example" })).toThrow(/OPSIFIER_API_KEY/);
  });

  it.each([
    "not an address",
    "ftp://panel.example",
    "https://panel.example/path",
    "https://user:pw@panel.example",
  ])("refuses OPSIFIER_URL=%s", (address) => {
    expect(() => connectionFromEnv({ OPSIFIER_URL: address, OPSIFIER_API_KEY: KEY })).toThrow(ClientError);
  });

  it("flags a key travelling in the clear to another machine, and only then", () => {
    expect(isExposedOnTheWire(new URL("http://panel.example"))).toBe(true);
    expect(isExposedOnTheWire(new URL("https://panel.example"))).toBe(false);
    expect(isExposedOnTheWire(new URL("http://127.0.0.1:3000"))).toBe(false);
    expect(isExposedOnTheWire(new URL("http://localhost:3000"))).toBe(false);
  });
});
