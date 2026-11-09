import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { classifyOperation, PanelClient } from "@opsifier/client";
import type { ActionEntry, ActionPage, ServiceDetail } from "@opsifier/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiErrorOf } from "../../../apps/server/src/testing/harness";
import { type LivePanel, startLivePanel } from "../../../apps/server/src/testing/live-panel";
import { McpServer, PROTOCOL_VERSIONS } from "./server";
import { serveStdio } from "./stdio";
import { ALL_TOOLS } from "./tools";

let panel: LivePanel;
let full: McpServer;
let fullKey: string;
let reader: McpServer;
let readerKey: string;
let scoped: McpServer;
let scopedKey: string;
let viewer: McpServer;
let viewerKey: string;

const clientFor = (key: string) => new PanelClient({ url: new URL(panel.url), apiKey: key });
const serverFor = (key: string) => new McpServer(clientFor(key), "test");

beforeAll(async () => {
  panel = await startLivePanel();
  fullKey = (await panel.createKey({ name: "agent", level: "write" })).token;
  readerKey = (await panel.createKey({ name: "reader", level: "read" })).token;
  scopedKey = (await panel.createKey({ name: "shop-only", level: "write", projects: ["shop"] })).token;
  const member = await panel.createMember("viewer@example.com", [{ project: "shop", role: "viewer" }]);
  viewerKey = (await panel.createKey({ name: "viewer", level: "write" }, member)).token;
  full = serverFor(fullKey);
  reader = serverFor(readerKey);
  scoped = serverFor(scopedKey);
  viewer = serverFor(viewerKey);
  await panel.deploy("shop", "web");
});

afterAll(async () => {
  await panel.close();
});

interface Answer {
  jsonrpc: string;
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

let nextId = 1;
async function rpc(server: McpServer, method: string, params?: Record<string, unknown>): Promise<Answer> {
  return (await server.handle({ jsonrpc: "2.0", id: nextId++, method, params })) as Answer;
}

interface ListedTool {
  name: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  inputSchema: { required?: string[] };
  _meta: Record<string, string>;
}

async function listed(server: McpServer): Promise<ListedTool[]> {
  return (await rpc(server, "tools/list")).result?.tools as ListedTool[];
}

const namesOf = async (server: McpServer) => (await listed(server)).map((tool) => tool.name);

async function callTool(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const { result } = await rpc(server, "tools/call", { name, arguments: args });
  const content = (result?.content ?? []) as Array<{ text: string }>;
  const text = content[0]?.text as string;
  return { isError: result?.isError === true, document: JSON.parse(text) as Record<string, unknown>, result };
}

const errorIn = (answer: { document: Record<string, unknown> }) =>
  answer.document.error as {
    code: string;
    message: string;
    status?: number;
    fields?: Record<string, string>;
    hint?: string;
  };

const API = "/api/v1/projects";
const WEB = `${API}/shop/services/web`;

const CHANGING_TOOLS = [
  "deploy_service",
  "restart_service",
  "start_service",
  "stop_service",
  "destroy_service",
  "delete_project",
  "cancel_action",
  "api_change",
];

describe("the protocol", () => {
  it("negotiates a version the way the client asks, or offers its newest", async () => {
    const known = await rpc(full, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "client", version: "1" },
    });
    expect(known.result?.protocolVersion).toBe("2025-06-18");
    expect(known.result?.capabilities).toEqual({ tools: {} });
    expect(known.result?.serverInfo).toEqual({ name: "opsifier", version: "test" });

    const future = await rpc(full, "initialize", { protocolVersion: "2099-01-01" });
    expect(future.result?.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it("answers a ping, says nothing to a notification, and refuses an unknown method", async () => {
    expect((await rpc(full, "ping")).result).toEqual({});
    expect(await full.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect((await rpc(full, "resources/list")).error?.code).toBe(-32601);
  });

  it("speaks one JSON message per line on stdio, and turns a broken line into a parse error", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const finished = serveStdio(full, input, output);

    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write("{ this is not json\n");
    input.end();
    await finished;

    const lines = (output.read() as Buffer)
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toContainEqual({ jsonrpc: "2.0", id: 7, result: {} });
    expect(lines).toContainEqual(
      expect.objectContaining({ id: null, error: expect.objectContaining({ code: -32700 }) }),
    );
    expect(lines).toHaveLength(2);
  });
});

describe("discovery", () => {
  it("shows a full key everything", async () => {
    expect((await namesOf(full)).sort()).toEqual(ALL_TOOLS.map((tool) => tool.name).sort());
  });

  it("marks every tool for read, change and risk, truthfully", async () => {
    for (const tool of await listed(full)) {
      const definition = ALL_TOOLS.find((candidate) => candidate.name === tool.name);
      expect(definition, tool.name).toBeDefined();
      expect(tool.annotations.readOnlyHint, tool.name).toBe(definition?.kind === "read");
      expect(tool.annotations.destructiveHint, tool.name).toBe(definition?.kind === "destructive");
      expect(tool._meta["dev.opsifier/access"], tool.name).toBe(definition?.kind);
      expect(["low", "medium", "high"], tool.name).toContain(tool._meta["dev.opsifier/risk"]);
      expect(tool.annotations.openWorldHint).toBe(false);
    }
    for (const tool of ALL_TOOLS.filter((candidate) => candidate.operation !== undefined)) {
      const operation = tool.operation as { method: string; path: string };
      expect(classifyOperation(operation.method, operation.path).kind, tool.name).toBe(tool.kind);
    }
  });

  it("shows a read-only key only what reads", async () => {
    const names = await namesOf(reader);

    expect(names).toEqual(
      expect.arrayContaining(["list_projects", "get_service", "get_service_logs", "get_action"]),
    );
    for (const tool of CHANGING_TOOLS) {
      expect(names, tool).not.toContain(tool);
    }
    for (const tool of await listed(reader)) {
      expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
    }
  });

  it("shows a viewer's key the inventory, not logs, deployments or changes", async () => {
    const names = await namesOf(viewer);

    expect(names).toEqual(expect.arrayContaining(["list_projects", "list_services", "get_service"]));
    expect(names).not.toContain("get_service_logs");
    expect(names).not.toContain("list_deployments");
    expect(names).not.toContain("deploy_service");
    expect(names).not.toContain("cancel_action");
    expect(names).not.toContain("api_change");
  });

  it("follows the panel: a key that changes level shows a different list on the next ask", async () => {
    const created = await panel.createKey({ name: "short", level: "write" });
    const server = serverFor(created.token);
    expect(await namesOf(server)).toContain("deploy_service");

    await panel.session("DELETE", `/api/v1/me/api-keys/${created.id}`);

    const answer = await rpc(server, "tools/list");
    expect(answer.error?.data).toMatchObject({ code: "invalid_token" });
  });

  it("lists only the operations this key may call, by the panel's own account", async () => {
    const operations = async (server: McpServer, search: string) =>
      (await callTool(server, "api_operations", { search })).document.operations as Array<{
        method: string;
        path: string;
        kind: string;
        risk: string;
      }>;

    const all = await operations(full, "");
    expect(all.length).toBeGreaterThan(15);
    expect(all.filter((entry) => entry.path.startsWith("/api/v1/auth/")).map((entry) => entry.path)).toEqual([
      "/api/v1/auth/identity",
    ]);
    expect(all.every((entry) => !entry.path.startsWith("/api/v1/deploy"))).toBe(true);
    expect(all.find((entry) => entry.path === "/api/v1/users")).toBeUndefined();
    expect(all.find((entry) => entry.path === "/api/v1/me/api-keys")).toBeUndefined();

    const read = await operations(reader, "");
    expect(read.every((entry) => entry.method === "GET")).toBe(true);

    expect(
      (await operations(scoped, "deploy")).some(
        (entry) => entry.path === `${API}/{project}/services/{service}/deploy`,
      ),
    ).toBe(true);
    expect((await operations(viewer, "environment")).length).toBe(0);
    expect((await operations(full, "environment")).length).toBeGreaterThan(0);
  });
});

/** The refusal has to be the API's own: same code and message, nothing softer or stricter. */
async function expectSameRefusal(
  key: string,
  answer: { isError: boolean; document: Record<string, unknown> },
  method: string,
  path: string,
  body?: unknown,
) {
  expect(answer.isError).toBe(true);
  const direct = await panel.direct(key, method, path, body);
  const viaTool = errorIn(answer);
  expect(viaTool.code).toBe(apiErrorOf(direct).code);
  expect(viaTool.message).toBe(apiErrorOf(direct).message);
  expect(viaTool.status).toBe(direct.status);
}

describe("a tool the key cannot use", () => {
  it("is refused exactly as the API refuses it, even if a client calls it unlisted", async () => {
    const before = (await panel.direct<ActionPage>(fullKey, "GET", "/api/v1/actions?limit=100")).body.items
      .length;

    const answer = await callTool(reader, "deploy_service", { project: "shop", service: "web" });

    await expectSameRefusal(readerKey, answer, "POST", `${WEB}/deploy`, {});
    expect(errorIn(answer).code).toBe("read_only_key");
    expect(errorIn(answer).hint).toMatch(/write/);
    const after = (await panel.direct<ActionPage>(fullKey, "GET", "/api/v1/actions?limit=100")).body.items
      .length;
    expect(after).toBe(before);
  });

  it("is refused for a project out of reach as if the project did not exist", async () => {
    const answer = await callTool(scoped, "get_service", { project: "secret", service: "web" });

    await expectSameRefusal(scopedKey, answer, "GET", `${API}/secret/services/web`);
    expect(errorIn(answer).code).toBe("not_found");
    expect(errorIn(answer).hint).toMatch(/cannot reach/);
  });

  it("is refused for a viewer's logs", async () => {
    const answer = await callTool(viewer, "get_service_logs", { project: "shop", service: "web" });

    await expectSameRefusal(viewerKey, answer, "GET", `${WEB}/logs/search`);
  });

  it("grants nothing through the generic tools either", async () => {
    const adminOnly = await callTool(full, "api_get", { path: "/api/v1/users" });
    await expectSameRefusal(fullKey, adminOnly, "GET", "/api/v1/users");
    expect(errorIn(adminOnly).code).toBe("session_required");

    const write = await callTool(reader, "api_change", { method: "POST", path: `${WEB}/deploy` });
    await expectSameRefusal(readerKey, write, "POST", `${WEB}/deploy`, {});

    const otherProject = await callTool(scoped, "api_get", { path: `${API}/secret/services/web` });
    await expectSameRefusal(scopedKey, otherProject, "GET", `${API}/secret/services/web`);
  });

  it("keeps a generic call on this panel, whatever address the path is dressed up as", async () => {
    const seen: string[] = [];
    const elsewhere = createServer((request, response) => {
      seen.push(request.url ?? "");
      response.end("{}");
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
    const { port } = elsewhere.address() as { port: number };

    const absolute = await callTool(full, "api_get", { path: `http://127.0.0.1:${port}/api/v1/projects` });
    const schemeRelative = await callTool(full, "api_get", { path: `//127.0.0.1:${port}/api/v1/projects` });

    await new Promise((resolve) => elsewhere.close(resolve));
    expect(absolute.isError).toBe(true);
    expect(errorIn(absolute).code).toBe("invalid_path");
    expect(schemeRelative.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("stops working the moment the key is revoked", async () => {
    const created = await panel.createKey({ name: "short-lived", level: "write" });
    const server = serverFor(created.token);
    expect((await callTool(server, "list_projects")).isError).toBe(false);

    await panel.session("DELETE", `/api/v1/me/api-keys/${created.id}`);

    const answer = await callTool(server, "list_projects");
    expect(answer.isError).toBe(true);
    expect(errorIn(answer).code).toBe("invalid_token");
    expect(errorIn(answer).hint).toMatch(/revoked/);
  });
});

describe("a redirect", () => {
  it("is refused, and the key does not follow it", async () => {
    const seen: Array<string | undefined> = [];
    const elsewhere = createServer((request, response) => {
      seen.push(request.headers.authorization);
      response.end("{}");
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
    const { port } = elsewhere.address() as { port: number };
    const moved = createServer((_request, response) => {
      response.writeHead(307, { location: `http://127.0.0.1:${port}/api/v1/projects` }).end();
    });
    await new Promise<void>((resolve) => moved.listen(0, "127.0.0.1", resolve));
    const movedPort = (moved.address() as { port: number }).port;
    const server = new McpServer(
      new PanelClient({ url: new URL(`http://127.0.0.1:${movedPort}`), apiKey: fullKey }),
      "test",
    );

    const answer = await callTool(server, "list_projects");

    await new Promise((resolve) => moved.close(resolve));
    await new Promise((resolve) => elsewhere.close(resolve));
    expect(answer.isError).toBe(true);
    expect(errorIn(answer).code).toBe("redirect_refused");
    expect(seen).toEqual([]);
  });
});

describe("useful errors", () => {
  it("names an unknown tool at the protocol level", async () => {
    const answer = await rpc(full, "tools/call", { name: "no_such_tool" });

    expect(answer.error?.code).toBe(-32602);
    expect(answer.error?.message).toContain("no_such_tool");
  });

  it("says which argument is missing, unknown or wrong, before anything is sent", async () => {
    const missing = await callTool(full, "get_service", { project: "shop" });
    expect(errorIn(missing)).toMatchObject({ code: "invalid_arguments", fields: { service: "Required" } });

    const unknown = await callTool(full, "get_service", { project: "shop", service: "web", extra: 1 });
    expect(errorIn(unknown).fields).toEqual({ extra: "Not an argument of this tool" });

    const wrongType = await callTool(full, "get_service_logs", {
      project: "shop",
      service: "web",
      limit: "many",
    });
    expect(errorIn(wrongType).fields).toEqual({ limit: "Must be an integer" });

    const wrongValue = await callTool(full, "list_actions", { status: "nearly done" });
    expect(errorIn(wrongValue).fields?.status).toContain("queued");
  });

  it("passes on the panel's own explanation, with the fields", async () => {
    const answer = await callTool(full, "api_change", {
      method: "POST",
      path: API,
      body: { name: "Not_Valid!" },
    });

    expect(answer.isError).toBe(true);
    expect(errorIn(answer)).toMatchObject({ code: "validation_failed", status: 400 });
    expect(errorIn(answer).fields?.name).toBeDefined();
  });

  it("says what to do about a conflict", async () => {
    await callTool(full, "deploy_service", { project: "shop", service: "web" });
    const answer = await callTool(full, "stop_service", { project: "shop", service: "web", confirm: "web" });

    expect(answer.isError).toBe(true);
    expect(errorIn(answer).status).toBe(409);
    expect(errorIn(answer).message).toBeTruthy();
  });
});

describe("destructive tools", () => {
  const actionsNow = async () =>
    (await panel.direct<ActionPage>(fullKey, "GET", "/api/v1/actions?limit=100")).body.items;

  beforeAll(async () => {
    await untilIdle("shop", "web");
    await panel.deploy("secret", "web");
  });

  it("refuse without a confirmation, and say what it has to be", async () => {
    const before = (await actionsNow()).length;

    const answer = await callTool(full, "stop_service", { project: "secret", service: "web" });

    expect(answer.isError).toBe(true);
    expect(errorIn(answer).code).toBe("confirmation_required");
    expect(errorIn(answer).message).toContain('"web"');
    expect((await actionsNow()).length).toBe(before);
  });

  it("refuse a confirmation that is not exactly the name", async () => {
    const answer = await callTool(full, "destroy_service", {
      project: "secret",
      service: "web",
      confirm: "WEB",
    });

    expect(errorIn(answer).code).toBe("confirmation_required");
    expect((await panel.direct(fullKey, "GET", `${API}/secret/services/web`)).status).toBe(200);
  });

  it("run once confirmed", async () => {
    await untilIdle("secret", "web");

    const answer = await callTool(full, "stop_service", {
      project: "secret",
      service: "web",
      confirm: "web",
    });

    expect(answer.isError).toBe(false);
    expect(answer.document).toMatchObject({ type: "service.stop", projectName: "secret" });
  });

  it("need the exact method and path through the generic tool", async () => {
    const path = `${API}/shop/services/web/maintenance`;
    const changes = await callTool(full, "api_change", {
      method: "PUT",
      path: `${WEB}/notes`,
      body: { notes: "from an agent" },
    });
    expect(changes.isError).toBe(false);

    const refused = await callTool(full, "api_change", { method: "DELETE", path });
    expect(errorIn(refused).code).toBe("confirmation_required");
    expect(errorIn(refused).message).toContain(`"DELETE ${path}"`);

    const confirmed = await callTool(full, "api_change", {
      method: "DELETE",
      path,
      confirm: `DELETE ${path}`,
    });
    // Confirmed locally, then refused or not by the panel alone: this one has no such route.
    expect(confirmed.document).not.toHaveProperty("error.code", "confirmation_required");
  });
});

describe("what happens through a tool", () => {
  it("is recorded under the key's own account and name", async () => {
    await untilIdle("shop", "web");

    const answer = await callTool(full, "restart_service", { project: "shop", service: "web" });

    expect(answer.isError).toBe(false);
    const id = (answer.document as unknown as ActionEntry).id;
    const action = await panel.direct<ActionEntry>(fullKey, "GET", `/api/v1/actions/${id}`);
    expect(action.body).toMatchObject({
      origin: "api_key",
      actorEmail: "admin@example.com",
      originDetail: "agent",
    });
  });

  it("reads the same data the API does", async () => {
    const viaTool = await callTool(full, "get_service", { project: "shop", service: "web" });
    const viaApi = await panel.direct<ServiceDetail>(fullKey, "GET", WEB);

    expect(viaTool.isError).toBe(false);
    expect(viaTool.document.name).toBe(viaApi.body.name);
    expect(viaTool.document.status).toBe(viaApi.body.status);
    expect(viaTool.result?.structuredContent).toEqual(viaTool.document);
  });

  it("reads a service's logs", async () => {
    panel.context.docker.writeLog("shop_web", "a line for the agent");

    const answer = await callTool(full, "get_service_logs", {
      project: "shop",
      service: "web",
      q: "for the agent",
    });

    expect(answer.isError).toBe(false);
    expect((answer.document.lines as Array<{ line: string }>).map((line) => line.line)).toEqual([
      "a line for the agent",
    ]);
  });

  it("does not hand over a whole build log in one answer", async () => {
    const answer = await callTool(full, "list_actions", { project: "shop", limit: 1 });
    const id = (answer.document.items as ActionEntry[])[0]?.id as string;

    const detail = await callTool(full, "get_action", { id });

    expect(detail.isError).toBe(false);
    expect(typeof detail.document.log).toBe("string");
    expect((detail.document.log as string).length).toBeLessThanOrEqual(20_000);
  });

  it("gives its whoami without the whole operation list", async () => {
    const answer = await callTool(full, "whoami");

    expect(answer.document).toMatchObject({
      user: { email: "admin@example.com" },
      credential: { kind: "api_key", name: "agent", level: "write" },
    });
    expect(answer.document).not.toHaveProperty("operations");
  });
});

async function untilIdle(project: string, service: string) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const detail = await panel.direct<ServiceDetail>(fullKey, "GET", `${API}/${project}/services/${service}`);
    if (detail.body.activeAction === null) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The service never settled.");
}
