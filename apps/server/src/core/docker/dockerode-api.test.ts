import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerodeDriver } from "./dockerode";
import { DockerDriverError } from "./driver";

/** Answers the Docker API's HTTP over a throwaway socket. No daemon is involved. */
type Responder = (request: IncomingMessage, response: ServerResponse) => void;

let directory: string;
let server: Server;
let driver: DockerodeDriver;
let requests: string[];
let respond: Responder;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "opsifier-api-"));
  const socketPath = join(directory, "d.sock");
  requests = [];
  respond = (_request, response) => json(response, 500, { message: "not expected" });
  server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    respond(request, response);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  driver = new DockerodeDriver({ socketPath });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

describe("removeVolume", () => {
  it("sends force to Docker", async () => {
    respond = (_request, response) => {
      response.statusCode = 204;
      response.end();
    };

    await driver.removeVolume("data", { force: true });

    expect(requests).toEqual(["DELETE /volumes/data?force=true"]);
  });

  it("does not force unless asked", async () => {
    respond = (_request, response) => {
      response.statusCode = 204;
      response.end();
    };

    await driver.removeVolume("data");

    expect(requests).toEqual(["DELETE /volumes/data?force=false"]);
  });

  it("treats a volume that is already gone as removed", async () => {
    respond = (_request, response) => json(response, 404, { message: "no such volume" });
    await expect(driver.removeVolume("data", { force: true })).resolves.toBeUndefined();
  });

  it("reports a volume that is still in use", async () => {
    respond = (_request, response) => json(response, 409, { message: "volume is in use" });

    const failure = await driver.removeVolume("data").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DockerDriverError);
    expect(failure).toMatchObject({ statusCode: 409 });
    expect((failure as Error).message).toContain("volume is in use");
  });
});

describe("listTasks", () => {
  it("answers with nothing for a service Docker does not know, like FakeDriver", async () => {
    respond = (request, response) => {
      if (request.url?.startsWith("/tasks")) {
        json(response, 404, { message: "service shop_web not found" });
      } else {
        json(response, 200, []);
      }
    };

    await expect(driver.listTasks({ service: "shop_web" })).resolves.toEqual([]);
  });

  it("still reports any other failure", async () => {
    respond = (_request, response) => json(response, 500, { message: "daemon on fire" });

    const failure = await driver.listTasks({ service: "shop_web" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DockerDriverError);
    expect(failure).toMatchObject({ statusCode: 500 });
  });

  it("lists tasks when the service exists", async () => {
    respond = (request, response) => {
      if (request.url?.startsWith("/tasks")) {
        json(response, 200, [
          {
            ID: "t1",
            ServiceID: "s1",
            DesiredState: "running",
            CreatedAt: "2026-01-01T00:00:00Z",
            UpdatedAt: "2026-01-01T00:00:00Z",
            Spec: { ContainerSpec: { Image: "nginx" } },
            Status: { State: "running" },
          },
        ]);
      } else {
        json(response, 200, [{ ID: "s1", Spec: { Name: "shop_web" } }]);
      }
    };

    const tasks = await driver.listTasks({ service: "shop_web" });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: "t1", serviceName: "shop_web", state: "running" });
  });
});

describe("taskAccess", () => {
  it("reads the host paths bound into a task and the capabilities added to it", async () => {
    respond = (_request, response) =>
      json(response, 200, {
        ID: "t1",
        ServiceID: "s1",
        DesiredState: "running",
        CreatedAt: "2026-01-01T00:00:00Z",
        UpdatedAt: "2026-01-01T00:00:00Z",
        Spec: {
          ContainerSpec: {
            Image: "nginx",
            Mounts: [
              { Type: "bind", Source: "/srv/shared", Target: "/data" },
              { Type: "volume", Source: "shop_web_data", Target: "/var/data" },
            ],
            CapabilityAdd: ["NET_ADMIN"],
          },
        },
        Status: { State: "running" },
      });

    await expect(driver.taskAccess("t1")).resolves.toEqual({
      binds: ["/srv/shared"],
      capabilityAdd: ["NET_ADMIN"],
    });
    expect(requests).toEqual([expect.stringMatching(/^GET \/tasks\/t1/)]);
  });

  it("answers null for a task Docker does not know", async () => {
    respond = (_request, response) => json(response, 404, { message: "task not found" });

    await expect(driver.taskAccess("gone")).resolves.toBeNull();
  });
});

describe("the proxy's plain container", () => {
  /** Reads a request's JSON body, for the calls that send one. */
  function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let text = "";
      request.on("data", (chunk) => {
        text += String(chunk);
      });
      request.on("end", () => resolve(text === "" ? {} : (JSON.parse(text) as Record<string, unknown>)));
    });
  }

  it("is created on the default bridge with its ports and folder, then joins its networks", async () => {
    let sent: Record<string, unknown> = {};
    respond = (request, response) => {
      void bodyOf(request).then((body) => {
        if (request.url?.startsWith("/containers/create")) {
          sent = body;
          json(response, 201, { Id: "c0ffee", Warnings: [] });
        } else {
          response.statusCode = 200;
          response.end();
        }
      });
    };

    const id = await driver.createPlainContainer({
      name: "opsifier-traefik",
      image: "traefik:3",
      env: ["A=1"],
      labels: { "opsifier.managed": "true" },
      binds: [{ source: "/var/lib/opsifier/traefik", target: "/var/lib/opsifier/traefik" }],
      ports: [80, 443],
      networks: ["opsifier", "shop_proxy"],
      stopTimeoutSeconds: 5,
    });

    expect(id).toBe("c0ffee");
    // The client repeats the options in the query string; Docker reads the body.
    expect(requests[0]).toMatch(/^POST \/containers\/create\?name=opsifier-traefik(&|$)/);
    expect(requests.slice(1)).toEqual([
      "POST /networks/opsifier/connect",
      "POST /networks/shop_proxy/connect",
    ]);
    expect(sent).toMatchObject({
      Image: "traefik:3",
      Env: ["A=1"],
      StopTimeout: 5,
      ExposedPorts: { "80/tcp": {}, "443/tcp": {} },
      HostConfig: {
        PortBindings: { "80/tcp": [{ HostPort: "80" }], "443/tcp": [{ HostPort: "443" }] },
        RestartPolicy: { Name: "unless-stopped" },
        Mounts: [{ Type: "bind", Source: "/var/lib/opsifier/traefik", Target: "/var/lib/opsifier/traefik" }],
      },
    });
    expect((sent.HostConfig as Record<string, unknown>).NetworkMode).toBeUndefined();
  });

  it("removes what it created when a network can't be joined", async () => {
    respond = (request, response) => {
      if (request.url?.startsWith("/containers/create")) {
        json(response, 201, { Id: "c0ffee", Warnings: [] });
      } else if (request.url?.startsWith("/networks/")) {
        json(response, 404, { message: "network shop_proxy not found" });
      } else {
        response.statusCode = 204;
        response.end();
      }
    };

    await expect(
      driver.createPlainContainer({
        name: "opsifier-traefik",
        image: "traefik:3",
        env: [],
        labels: {},
        binds: [],
        ports: [80],
        networks: ["shop_proxy"],
        stopTimeoutSeconds: 5,
      }),
    ).rejects.toBeInstanceOf(DockerDriverError);
    expect(requests.at(-1)).toMatch(/^DELETE \/containers\/c0ffee/);
  });

  it("reads what it is from Docker, with the networks it is on", async () => {
    respond = (_request, response) =>
      json(response, 200, {
        Id: "c0ffee",
        Name: "/opsifier-traefik",
        RestartCount: 2,
        State: { Status: "running", ExitCode: 0, StartedAt: "2026-11-16T20:00:00Z" },
        Config: { Image: "traefik:3", Env: ["A=1"], Labels: { "opsifier.managed": "true" } },
        HostConfig: {
          Mounts: [{ Type: "bind", Source: "/data/traefik", Target: "/data/traefik" }],
          PortBindings: { "80/tcp": [{ HostPort: "80" }], "443/tcp": [{ HostPort: "443" }] },
        },
        NetworkSettings: { Networks: { opsifier: { NetworkID: "n1" }, shop_proxy: { NetworkID: "n2" } } },
      });

    const info = await driver.inspectPlainContainer("opsifier-traefik");

    expect(info).toEqual({
      id: "c0ffee",
      name: "opsifier-traefik",
      image: "traefik:3",
      state: "running",
      exitCode: null,
      startedAt: "2026-11-16T20:00:00Z",
      restartCount: 2,
      env: ["A=1"],
      labels: { "opsifier.managed": "true" },
      binds: [{ source: "/data/traefik", target: "/data/traefik" }],
      ports: [80, 443],
      networks: [
        { name: "opsifier", id: "n1" },
        { name: "shop_proxy", id: "n2" },
      ],
    });
  });

  it("is null when Docker has no such container, and never started when Docker says the zero time", async () => {
    respond = (_request, response) => json(response, 404, { message: "No such container: opsifier-traefik" });
    await expect(driver.inspectPlainContainer("opsifier-traefik")).resolves.toBeNull();

    respond = (_request, response) =>
      json(response, 200, {
        Id: "c1",
        Name: "/x",
        State: { Status: "created", StartedAt: "0001-01-01T00:00:00Z" },
      });
    await expect(driver.inspectPlainContainer("x")).resolves.toMatchObject({
      startedAt: null,
      exitCode: null,
    });
  });

  it("takes starting one already running, and stopping one already stopped or gone, as done", async () => {
    respond = (_request, response) => {
      response.statusCode = 304;
      response.end();
    };
    await expect(driver.startContainer("opsifier-traefik")).resolves.toBeUndefined();
    await expect(driver.stopContainer("opsifier-traefik", { timeoutSeconds: 5 })).resolves.toBeUndefined();
    respond = (_request, response) => json(response, 404, { message: "No such container" });
    await expect(driver.stopContainer("opsifier-traefik")).resolves.toBeUndefined();
    expect(requests).toContain("POST /containers/opsifier-traefik/stop?t=5");
  });

  it("joins a network it is already on, and leaves one it is not on, without an error", async () => {
    respond = (_request, response) =>
      json(response, 403, {
        message: "endpoint with name opsifier-traefik already exists in network shop_proxy",
      });
    await expect(driver.connectNetwork("shop_proxy", "opsifier-traefik")).resolves.toBeUndefined();

    respond = (_request, response) =>
      json(response, 500, { message: "container c0ffee is not connected to network shop_proxy" });
    await expect(driver.disconnectNetwork("shop_proxy", "opsifier-traefik")).resolves.toBeUndefined();

    respond = (_request, response) => json(response, 404, { message: "network shop_proxy not found" });
    await expect(driver.disconnectNetwork("shop_proxy", "opsifier-traefik")).resolves.toBeUndefined();

    expect(requests).toEqual([
      "POST /networks/shop_proxy/connect",
      "POST /networks/shop_proxy/disconnect",
      "POST /networks/shop_proxy/disconnect",
    ]);
  });

  it("reports a network it can't join", async () => {
    respond = (_request, response) => json(response, 404, { message: "network shop_proxy not found" });

    const failure = await driver
      .connectNetwork("shop_proxy", "opsifier-traefik")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DockerDriverError);
    expect(failure).toMatchObject({ statusCode: 404 });
  });
});
