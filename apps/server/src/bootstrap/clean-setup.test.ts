import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../core/db";
import { users } from "../core/db/schema";
import { DockerDriverError, FakeDriver } from "../core/docker";
import { createSecrets } from "../core/secrets";
import { FakeTools } from "../core/tools";
import { ADDRESS_SECRET_CONTEXT, readAddress, saveAddress } from "../features/opsifier-address/repo";
import { addressRegisteredSince, panelHasAccounts } from "./address";
import { type CleanSetupDeps, runCleanSetup } from "./clean-setup";
import { readRecord, SETUP_RUN_LABEL, STATE_FILE } from "./ledger";
import { runSetup, type SetupDeps } from "./setup";
import { MANAGED_LABEL, PANEL_SWARM_SERVICE, PROXY_SWARM_SERVICE, panelServiceSpec } from "./specs";

const IMAGE = "ghcr.io/example/opsifier:1.0.0";

let dataDir: string;
let log: string[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "opsifier-clean-setup-"));
  log = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

function pump(docker: FakeDriver): () => void {
  const timer = setInterval(() => docker.advance(8), 1);
  return () => clearInterval(timer);
}

async function setup(docker: FakeDriver, extra: Partial<SetupDeps> = {}) {
  const stop = pump(docker);
  try {
    return await runSetup(
      { force: false, image: IMAGE },
      {
        docker,
        tools: new FakeTools(),
        dockerEnv: {},
        dataDir,
        setupTokenFile: join(dataDir, "setup-token"),
        log: (line) => log.push(line),
        timing: { pollMs: 1, startupMs: 2000, tokenWaitMs: 20, lockStaleMs: 60_000 },
        isPortTaken: async () => false,
        ...extra,
      },
    );
  } finally {
    stop();
  }
}

/** Runs setup so that it dies making the panel's service, with the proxy and everything before it done. */
async function interrupt(docker: FakeDriver, extra: Partial<SetupDeps> = {}): Promise<void> {
  const original = docker.createService.bind(docker);
  docker.createService = async (spec, options) => {
    if (spec.Name === PANEL_SWARM_SERVICE) {
      throw new DockerDriverError("the daemon went away", 500);
    }
    return original(spec, options);
  };
  await expect(setup(docker, extra)).rejects.toThrow(/daemon went away/);
  docker.createService = original;
}

const clean = (docker: FakeDriver, confirmed = true, extra: Partial<CleanSetupDeps> = {}) => {
  const stop = pump(docker);
  return runCleanSetup(
    {
      docker,
      dataDir,
      log: (line) => log.push(line),
      hasAccounts: () => false,
      timing: { pollMs: 1, startupMs: 200, lockStaleMs: 60_000 },
      ...extra,
    },
    { confirmed },
  ).finally(stop);
};

const stateFile = () => join(dataDir, STATE_FILE);

describe("what an interrupted setup leaves behind", () => {
  it("is written down before it is made, so a run that dies has said what it was doing", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    await interrupt(docker);

    const record = readRecord(dataDir);
    expect(record?.phase).toBe("panel");
    expect(record?.runId).toMatch(/^[0-9a-f]{16}$/);
    expect(record?.created).toEqual([
      { kind: "swarm", nodeId: (await docker.swarmInfo()).nodeId },
      { kind: "network", name: "opsifier", id: (await docker.inspectNetwork("opsifier"))?.id },
      { kind: "image", ref: "traefik:3" },
      {
        kind: "service",
        name: PROXY_SWARM_SERVICE,
        id: (await docker.inspectService(PROXY_SWARM_SERVICE))?.id,
      },
      { kind: "service", name: PANEL_SWARM_SERVICE, id: null },
    ]);
  });

  it("carries the run's own id, set in the same call that makes it", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    await interrupt(docker);

    const runId = readRecord(dataDir)?.runId;
    expect((await docker.inspectService(PROXY_SWARM_SERVICE))?.spec.Labels?.[SETUP_RUN_LABEL]).toBe(runId);
    expect((await docker.inspectNetwork("opsifier"))?.labels[SETUP_RUN_LABEL]).toBe(runId);
  });

  it("removes everything the run made and leaves nothing of it", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    await interrupt(docker);

    const result = await clean(docker);

    expect(result.confirmed).toBe(true);
    expect(await docker.inspectService(PROXY_SWARM_SERVICE)).toBeNull();
    expect(await docker.inspectNetwork("opsifier")).toBeNull();
    expect((await docker.swarmInfo()).state).toBe("inactive");
    expect(await docker.inspectImage("traefik:3")).toBeNull();
    expect(existsSync(join(dataDir, "traefik"))).toBe(false);
    expect(existsSync(stateFile())).toBe(false);
  });

  it("only says what it would do until it is told to", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    await interrupt(docker);

    const result = await clean(docker, false);

    expect(result.confirmed).toBe(false);
    expect(result.removed).toEqual(
      expect.arrayContaining([
        `the service "${PROXY_SWARM_SERVICE}"`,
        'the network "opsifier"',
        "the Swarm this setup started",
      ]),
    );
    expect(log.join("\n")).toContain("clean-setup --yes");
    expect(await docker.inspectService(PROXY_SWARM_SERVICE)).not.toBeNull();
    expect((await docker.swarmInfo()).state).toBe("active");
    expect(existsSync(stateFile())).toBe(true);
  });

  it("can pick up where a run died in the middle of making something", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    const original = docker.createService.bind(docker);
    docker.createService = async (spec, options) => {
      await original(spec, options);
      throw new DockerDriverError("the panel lost its connection", 500);
    };
    await expect(setup(docker)).rejects.toThrow(/connection/);
    docker.createService = original;
    // Docker made it, but the id never got written down: the label is what ties it to this run.
    expect(readRecord(dataDir)?.created?.find((entry) => entry.kind === "service")).toMatchObject({
      id: null,
    });

    await clean(docker);

    expect(await docker.inspectService(PROXY_SWARM_SERVICE)).toBeNull();
  });

  it("waits for a task's container to let go of the image it pulled", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    await interrupt(docker);
    const removeImage = docker.removeImage.bind(docker);
    let attempts = 0;
    docker.removeImage = async (ref) => {
      attempts += 1;
      if (attempts < 3) {
        throw new DockerDriverError("conflict: image is being used by a stopped container", 409);
      }
      return removeImage(ref);
    };

    await clean(docker);

    expect(attempts).toBe(3);
    expect(await docker.inspectImage("traefik:3")).toBeNull();
  });

  it("leaves an image something else is really using, and says so", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    await interrupt(docker);
    docker.removeImage = async () => {
      throw new DockerDriverError("conflict: image is being used by running container", 409);
    };

    const result = await clean(docker, true, { timing: { pollMs: 1, startupMs: 10, lockStaleMs: 60_000 } });

    expect(result.confirmed).toBe(true);
    expect(log.join("\n")).toContain("Left traefik:3 in place");
    expect(existsSync(stateFile())).toBe(false);
  });

  it("isn't held back from leaving the Swarm by a network that is still on its way out", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    await interrupt(docker);
    // Docker's own removal returned, but its listing has not caught up yet.
    docker.removeNetwork = async () => {};

    await clean(docker);

    expect((await docker.swarmInfo()).state).toBe("inactive");
  });

  it("can be run again after stopping partway, because the record stays until the end", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    await interrupt(docker);
    const removeNetwork = docker.removeNetwork.bind(docker);
    docker.removeNetwork = async () => {
      throw new DockerDriverError("network has active endpoints", 403);
    };

    await expect(
      clean(docker, true, { timing: { pollMs: 1, startupMs: 20, lockStaleMs: 60_000 } }),
    ).rejects.toThrow(/active endpoints/);
    expect(existsSync(stateFile())).toBe(true);
    expect(await docker.inspectService(PROXY_SWARM_SERVICE)).toBeNull();

    docker.removeNetwork = removeNetwork;
    await clean(docker);

    expect(await docker.inspectNetwork("opsifier")).toBeNull();
    expect((await docker.swarmInfo()).state).toBe("inactive");
    expect(existsSync(stateFile())).toBe(false);
  });

  it("gives setup a clean start afterwards", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    await interrupt(docker);
    await clean(docker);
    writeFileSync(join(dataDir, "setup-token"), "a".repeat(43));

    const result = await setup(docker);

    expect(result.changed).toEqual([`created ${PROXY_SWARM_SERVICE}`, `created ${PANEL_SWARM_SERVICE}`]);
  });
});

describe("what was not this run's to remove", () => {
  it("leaves a Swarm that was already there, with everything on it", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    await docker.createService({
      Name: "someone_else",
      TaskTemplate: { ContainerSpec: { Image: "nginx:alpine" } },
      Mode: { Replicated: { Replicas: 1 } },
    });
    await interrupt(docker);

    await clean(docker);

    expect((await docker.swarmInfo()).state).toBe("active");
    expect(await docker.inspectService("someone_else")).not.toBeNull();
    expect(await docker.inspectService(PROXY_SWARM_SERVICE)).toBeNull();
  });

  it("leaves a network it did not create", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    expect(await docker.inspectNetwork("opsifier")).not.toBeNull();
    await interrupt(docker);

    await clean(docker);

    expect(await docker.inspectNetwork("opsifier")).not.toBeNull();
  });

  it("leaves a service of ours that an earlier, finished setup created", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    await docker.createService({
      ...panelServiceSpec({ dataDir, image: IMAGE, networkId: "n", trustedProxies: [] }),
      Name: PROXY_SWARM_SERVICE,
    });
    await interrupt(docker);

    await clean(docker);

    expect((await docker.inspectService(PROXY_SWARM_SERVICE))?.spec.Labels?.[MANAGED_LABEL]).toBe("true");
  });

  it("will not take something that has replaced what it made, or the files around it", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    await interrupt(docker);
    await docker.removeService(PROXY_SWARM_SERVICE);
    await docker.createService({
      Name: PROXY_SWARM_SERVICE,
      TaskTemplate: { ContainerSpec: { Image: "someone/elses:proxy" } },
      Mode: { Replicated: { Replicas: 1 } },
    });

    const result = await clean(docker);

    expect(result.kept.join("\n")).toContain(`the service "${PROXY_SWARM_SERVICE}"`);
    expect(await docker.inspectService(PROXY_SWARM_SERVICE)).not.toBeNull();
    expect(existsSync(join(dataDir, "traefik"))).toBe(true);
  });

  it("keeps the Swarm it started when anything else has moved in", async () => {
    for (const [what, arrange] of [
      [
        "a service",
        (docker: FakeDriver) =>
          docker.createService({
            Name: "someone_else",
            TaskTemplate: { ContainerSpec: { Image: "nginx:alpine" } },
            Mode: { Replicated: { Replicas: 1 } },
          }),
      ],
      ["a network", (docker: FakeDriver) => docker.createNetwork({ name: "others", labels: {} })],
      [
        "a node",
        (docker: FakeDriver) => {
          docker.swarmExtras = { nodes: 2, secrets: 0, configs: 0 };
        },
      ],
      [
        "a secret",
        (docker: FakeDriver) => {
          docker.swarmExtras = { nodes: 1, secrets: 1, configs: 0 };
        },
      ],
    ] as const) {
      const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
      await interrupt(docker);
      await arrange(docker);

      const result = await clean(docker);

      expect((await docker.swarmInfo()).state, what).toBe("active");
      expect(result.kept.join("\n"), what).toContain("the Swarm this setup started");
      expect(await docker.inspectService(PROXY_SWARM_SERVICE), what).toBeNull();
      rmSync(join(dataDir, STATE_FILE), { force: true });
    }
  });

  it("leaves files that were there before it began, and removes the ones it made", async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "precious"), "keep me");
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    await interrupt(docker);
    writeFileSync(join(dataDir, "opsifier.db"), "");

    const result = await clean(docker);

    expect(readFileSync(join(dataDir, "precious"), "utf8")).toBe("keep me");
    expect(existsSync(join(dataDir, "opsifier.db"))).toBe(false);
    expect(result.kept.join("\n")).toContain("precious");
  });
});

describe("when there is nothing that is safe to remove", () => {
  it("has nothing to say about a server no setup has run on", async () => {
    await expect(clean(new FakeDriver({ tickMs: 1 }))).rejects.toThrow(/no record of a setup/);
  });

  it("refuses a setup that finished, and changes nothing", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeFileSync(join(dataDir, "setup-token"), "a".repeat(43));
    await setup(docker);

    await expect(clean(docker)).rejects.toThrow(/finished/);

    expect(await docker.inspectService(PANEL_SWARM_SERVICE)).not.toBeNull();
    expect((await docker.swarmInfo()).state).toBe("active");
    expect(readRecord(dataDir)?.phase).toBe("complete");
  });

  it("refuses when someone has already claimed the panel", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    await interrupt(docker);

    await expect(clean(docker, true, { hasAccounts: () => true })).rejects.toThrow(/in use/);

    expect(await docker.inspectService(PROXY_SWARM_SERVICE)).not.toBeNull();
  });

  it("refuses when it can't tell whether anyone has", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    await interrupt(docker);

    await expect(
      clean(docker, true, {
        hasAccounts: () => {
          throw new Error("database disk image is malformed");
        },
      }),
    ).rejects.toThrow(/nothing has been changed.*malformed/i);

    expect(await docker.inspectService(PROXY_SWARM_SERVICE)).not.toBeNull();
  });

  it("refuses a setup from before steps were recorded", async () => {
    writeFileSync(stateFile(), JSON.stringify({ phase: "network" }));

    await expect(clean(new FakeDriver({ tickMs: 1 }))).rejects.toThrow(/attributed/);
  });

  it("stops when Docker can't be asked", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    await interrupt(docker);
    docker.failNext("ping");

    await expect(clean(docker)).rejects.toThrow(/does not answer/);

    expect(existsSync(stateFile())).toBe(true);
  });

  it("refuses while another setup holds the lock", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    await interrupt(docker);
    writeFileSync(join(dataDir, "setup.lock"), "");

    await expect(clean(docker)).rejects.toThrow(/already running/);
  });
});

describe("a run picked up again", () => {
  it("keeps its id and what it made, and is no longer anything to clean", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    await interrupt(docker);
    const runId = readRecord(dataDir)?.runId;
    writeFileSync(join(dataDir, "setup-token"), "a".repeat(43));

    await setup(docker);

    expect(readRecord(dataDir)).toMatchObject({ runId, phase: "complete" });
    expect((await docker.inspectService(PANEL_SWARM_SERVICE))?.spec.Labels?.[SETUP_RUN_LABEL]).toBe(runId);
    await expect(clean(docker)).rejects.toThrow(/finished/);
  });

  it("starts a new record the next time around, so earlier work stays out of it", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeFileSync(join(dataDir, "setup-token"), "a".repeat(43));
    await setup(docker);
    const first = readRecord(dataDir)?.runId;
    await docker.removeService(PANEL_SWARM_SERVICE);

    await interrupt(docker);

    expect(readRecord(dataDir)?.runId).not.toBe(first);
    expect(readRecord(dataDir)?.created?.map((entry) => entry.kind)).toEqual(["service"]);
    await clean(docker);
    // The proxy from the finished setup was never this run's.
    expect(await docker.inspectService(PROXY_SWARM_SERVICE)).not.toBeNull();
    expect((await docker.swarmInfo()).state).toBe("active");
  });
});

describe("the panel's own data", () => {
  const databaseFile = () => join(dataDir, "opsifier.db");

  it("counts as in use once it has an account", () => {
    expect(panelHasAccounts(databaseFile())).toBe(false);
    const handle = openDatabase(databaseFile());
    expect(panelHasAccounts(databaseFile())).toBe(false);
    handle.db
      .insert(users)
      .values({
        id: "u1",
        name: "Ada",
        email: "ada@example.com",
        passwordHash: "x",
        role: "admin",
        isOwner: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    handle.close();

    expect(panelHasAccounts(databaseFile())).toBe(true);
  });

  it("is read without assuming a schema that may never have been written", () => {
    const handle = openDatabase(databaseFile(), null);
    handle.close();

    expect(panelHasAccounts(databaseFile())).toBe(false);
  });

  describe("an address registered during the run", () => {
    const ID = "bcdfghjk";
    const SECRET = "s".repeat(43);
    const config = () => ({
      namesUrl: "https://names.test",
      dataDir,
      databaseFile: databaseFile(),
      secretKeyFile: join(dataDir, "secret.key"),
    });

    function stored(registeredAt: string): void {
      const secrets = createSecrets(join(dataDir, "secret.key"), { allowCreate: true });
      const handle = openDatabase(databaseFile());
      saveAddress(
        handle.db,
        {
          status: "registered",
          id: ID,
          domain: `${ID}.opsifier.dev`,
          sealedSecret: secrets.seal(SECRET, ADDRESS_SECRET_CONTEXT),
          ip: "93.184.216.34",
          registeredAt,
          lastHeartbeatAt: null,
          health: "ok",
        },
        new Date(registeredAt),
      );
      handle.close();
      mkdirSync(join(dataDir, "traefik"), { recursive: true });
      writeFileSync(join(dataDir, "traefik", "opsifier-address.secret"), SECRET);
    }

    it("is given back, and forgotten", async () => {
      stored("2026-11-09T10:00:00.000Z");
      const released = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", released);

      const address = addressRegisteredSince(config(), "2026-11-09T09:00:00.000Z");
      expect(address?.domain).toBe(`${ID}.opsifier.dev`);
      await address?.release((line) => log.push(line));

      expect(released).toHaveBeenCalledTimes(1);
      expect(String(released.mock.calls[0]?.at(0))).toBe(`https://names.test/v1/servers/${ID}`);
      expect(existsSync(join(dataDir, "traefik", "opsifier-address.secret"))).toBe(false);
      const handle = openDatabase(databaseFile());
      expect(readAddress(handle.db)).toBeNull();
      handle.close();
    });

    it("is still forgotten when the address service can't be reached, and says so", async () => {
      stored("2026-11-09T10:00:00.000Z");
      vi.stubGlobal("fetch", async () => {
        throw new TypeError("network");
      });

      await addressRegisteredSince(config(), "2026-11-09T09:00:00.000Z")?.release((line) => log.push(line));

      expect(log.join("\n")).toContain("expires by itself");
      const handle = openDatabase(databaseFile());
      expect(readAddress(handle.db)).toBeNull();
      handle.close();
    });

    it("stays when it is older than the run", () => {
      stored("2026-11-09T08:00:00.000Z");

      expect(addressRegisteredSince(config(), "2026-11-09T09:00:00.000Z")).toBeNull();
    });
  });
});
