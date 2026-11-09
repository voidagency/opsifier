import type { SystemInfo } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, createTestContext, setupAdmin, type TestContext } from "../../testing/harness";

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
});

afterEach(async () => {
  await context.close();
});

describe("the system feature", () => {
  it("reports the version and the detected server IP, and requires sign-in", async () => {
    expect((await call(context.app, "/api/v1/system/info")).status).toBe(401);

    const result = await call<SystemInfo>(context.app, "/api/v1/system/info", { cookie });
    expect(result.status).toBe(200);
    expect(result.body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.body.serverIp).toBe("203.0.113.10");
  });

  it("says when the panel runs on the simulated driver", async () => {
    const simulated = await call<SystemInfo>(context.app, "/api/v1/system/info", { cookie });
    expect(simulated.body.simulated).toBe(true);

    Object.defineProperty(context.docker, "kind", { value: "dockerode" });
    const real = await call<SystemInfo>(context.app, "/api/v1/system/info", { cookie });
    expect(real.body.simulated).toBe(false);
  });

  it("uses a configured server IP over a detected one", async () => {
    const configured = await createTestContext({ env: { OPSIFIER_SERVER_IP: "198.51.100.7" } });
    const session = await setupAdmin(configured.app);
    const result = await call<SystemInfo>(configured.app, "/api/v1/system/info", { cookie: session });
    expect(result.body.serverIp).toBe("198.51.100.7");
    await configured.close();
  });
});
