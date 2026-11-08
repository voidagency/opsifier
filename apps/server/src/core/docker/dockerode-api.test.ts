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
