import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDriver, type SwarmServiceSpec } from "../core/docker";
import { FakeTools } from "../core/tools";
import { readJournal, writeJournal } from "../features/panel-update/journal";
import type { AddressForProxy, SetupAddress } from "./address";
import { parseArgs } from "./cli";
import { runRollback } from "./rollback";
import { runSetup, type SetupDeps, SetupError, type SetupOptions } from "./setup";
import {
  MANAGED_LABEL,
  PANEL_SWARM_SERVICE,
  PROXY_SWARM_SERVICE,
  panelServiceSpec,
  proxyServiceSpec,
} from "./specs";

const IMAGE = "ghcr.io/example/opsifier:1.0.0";

let dataDir: string;
let log: string[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "opsifier-setup-"));
  log = [];
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** The fake never advances tasks by itself quickly enough for a test, so this does. */
function pump(docker: FakeDriver): () => void {
  const timer = setInterval(() => docker.advance(8), 1);
  return () => clearInterval(timer);
}

async function setup(
  docker: FakeDriver,
  options: Partial<SetupOptions> = {},
  extra: Partial<Pick<SetupDeps, "address" | "timing" | "tools">> = {},
) {
  const stop = pump(docker);
  try {
    return await runSetup(
      { force: false, image: IMAGE, ...options },
      {
        docker,
        tools: extra.tools ?? new FakeTools(),
        dockerEnv: {},
        dataDir,
        setupTokenFile: join(dataDir, "setup-token"),
        log: (line) => log.push(line),
        timing: { pollMs: 1, startupMs: 2000, tokenWaitMs: 20, lockStaleMs: 60_000, ...extra.timing },
        isPortTaken: async () => false,
        address: extra.address,
      },
    );
  } finally {
    stop();
  }
}

function writeToken(token = "a".repeat(43)): string {
  writeFileSync(join(dataDir, "setup-token"), `${token}\n`, { mode: 0o600 });
  return token;
}

const envOf = (spec: SwarmServiceSpec | undefined) => spec?.TaskTemplate.ContainerSpec.Env ?? [];

describe("setup on a fresh server", () => {
  it("initializes Swarm, creates the network and starts both services", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    const token = writeToken();

    const result = await setup(docker, { advertiseAddr: "203.0.113.7" });

    expect((await docker.swarmInfo()).state).toBe("active");
    const network = await docker.inspectNetwork("opsifier");
    expect(network).toMatchObject({ driver: "overlay", attachable: true });

    const proxy = await docker.inspectService(PROXY_SWARM_SERVICE);
    expect(proxy?.spec.TaskTemplate.ContainerSpec.Image).toBe("traefik:3");
    expect(proxy?.spec.EndpointSpec?.Ports).toEqual([
      expect.objectContaining({ PublishedPort: 80, PublishMode: "host" }),
      expect.objectContaining({ PublishedPort: 443, PublishMode: "host" }),
    ]);
    expect(proxy?.spec.TaskTemplate.ContainerSpec.Mounts).toEqual([
      { Type: "bind", Source: `${dataDir}/traefik`, Target: `${dataDir}/traefik` },
    ]);

    const panel = await docker.inspectService(PANEL_SWARM_SERVICE);
    expect(panel?.spec.TaskTemplate.ContainerSpec.Image).toBe(IMAGE);
    expect(panel?.spec.EndpointSpec?.Ports).toEqual([
      expect.objectContaining({ PublishedPort: 3000, PublishMode: "host" }),
    ]);
    expect(panel?.spec.TaskTemplate.ContainerSpec.Mounts?.map((mount) => mount.Source)).toEqual([
      "/var/run/docker.sock",
      dataDir,
    ]);
    expect(panel?.spec.UpdateConfig).toMatchObject({ FailureAction: "rollback", Order: "stop-first" });

    expect(result.urls).toContain(`http://${(await docker.swarmInfo()).nodeAddr}:3000/setup?token=${token}`);
    expect(result.firstRun).toBe(true);
    expect(result.changed).toEqual([`created ${PROXY_SWARM_SERVICE}`, `created ${PANEL_SWARM_SERVICE}`]);
  });

  it("trusts forwarded headers from the overlay network's subnet", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();

    await setup(docker);

    const network = await docker.inspectNetwork("opsifier");
    expect(network?.subnets?.length).toBeGreaterThan(0);
    const panel = await docker.inspectService(PANEL_SWARM_SERVICE);
    expect(envOf(panel?.spec)).toContain(`OPSIFIER_TRUSTED_PROXIES=${network?.subnets?.join(",")}`);
  });

  it("labels what it creates, so a later run can recognize it", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();

    await setup(docker);

    for (const name of [PANEL_SWARM_SERVICE, PROXY_SWARM_SERVICE]) {
      expect((await docker.inspectService(name))?.spec.Labels?.[MANAGED_LABEL]).toBe("true");
    }
  });

  it("uses the address the people reach the server on, when told one", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();

    const result = await setup(docker, { serverIp: "198.51.100.4" });

    expect(result.urls[0]).toMatch(/^http:\/\/198\.51\.100\.4:3000\/setup\?token=/);
    expect(result.urls[1]).toMatch(/^https:\/\/panel\.198\.51\.100\.4\.sslip\.io\/setup\?token=/);
    expect(envOf((await docker.inspectService(PANEL_SWARM_SERVICE))?.spec)).toContain(
      "OPSIFIER_SERVER_IP=198.51.100.4",
    );
  });

  it("creates the data directories Traefik's bind mount needs", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();

    await setup(docker);

    expect(statSync(join(dataDir, "traefik", "dynamic")).isDirectory()).toBe(true);
  });
});

describe("setup on a server that already has something", () => {
  it("keeps an existing Swarm and whatever runs on it", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    await docker.createService({
      Name: "someone_else",
      TaskTemplate: { ContainerSpec: { Image: "nginx:alpine" } },
      Mode: { Replicated: { Replicas: 1 } },
    });
    writeToken();

    await setup(docker);

    expect((await docker.swarmInfo()).state).toBe("active");
    expect(await docker.inspectService("someone_else")).not.toBeNull();
  });

  it("is idempotent: a second run changes nothing and restarts nothing", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    const token = writeToken();
    await setup(docker);
    const [panelBefore, proxyBefore] = await Promise.all([
      docker.inspectService(PANEL_SWARM_SERVICE),
      docker.inspectService(PROXY_SWARM_SERVICE),
    ]);

    const second = await setup(docker);

    expect(second.changed).toEqual([]);
    expect(second.urls[0]).toContain(token);
    const [panelAfter, proxyAfter] = await Promise.all([
      docker.inspectService(PANEL_SWARM_SERVICE),
      docker.inspectService(PROXY_SWARM_SERVICE),
    ]);
    expect(panelAfter?.version).toBe(panelBefore?.version);
    expect(proxyAfter?.version).toBe(proxyBefore?.version);
  });

  it("repairs a service of ours that lost what it needs, and keeps its image", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();
    await setup(docker);
    const panel = await docker.inspectService(PANEL_SWARM_SERVICE);
    await docker.updateService(PANEL_SWARM_SERVICE, {
      ...(panel?.spec as SwarmServiceSpec),
      TaskTemplate: {
        ...(panel?.spec.TaskTemplate as SwarmServiceSpec["TaskTemplate"]),
        ContainerSpec: {
          ...(panel?.spec.TaskTemplate.ContainerSpec as object),
          Image: "ghcr.io/example/opsifier:2.0.0",
          Env: [],
        } as never,
      },
    });

    const again = await setup(docker, { image: "ghcr.io/example/opsifier:9.9.9" });

    const repaired = await docker.inspectService(PANEL_SWARM_SERVICE);
    expect(again.changed).toEqual([`updated ${PANEL_SWARM_SERVICE}`]);
    expect(envOf(repaired?.spec)).toContainEqual(expect.stringMatching(/^OPSIFIER_TRUSTED_PROXIES=/));
    expect(repaired?.spec.TaskTemplate.ContainerSpec.Image).toBe("ghcr.io/example/opsifier:2.0.0");
  });

  it("says when the panel has an administrator already", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();
    await setup(docker);
    rmSync(join(dataDir, "setup-token"));

    const again = await setup(docker);

    expect(again.firstRun).toBe(false);
    expect(again.urls[0]).not.toContain("token=");
  });

  it("never touches a service it did not create", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    await docker.createService({
      Name: PANEL_SWARM_SERVICE,
      TaskTemplate: { ContainerSpec: { Image: "someone/elses:panel" } },
      Mode: { Replicated: { Replicas: 1 } },
    });

    await expect(setup(docker)).rejects.toThrow(/--force/);

    expect((await docker.inspectService(PANEL_SWARM_SERVICE))?.spec.TaskTemplate.ContainerSpec.Image).toBe(
      "someone/elses:panel",
    );
    expect(await docker.inspectService(PROXY_SWARM_SERVICE)).toBeNull();
  });

  it("replaces such a service only with --force", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    await docker.createService({
      Name: PANEL_SWARM_SERVICE,
      TaskTemplate: { ContainerSpec: { Image: "someone/elses:panel" } },
      Mode: { Replicated: { Replicas: 1 } },
    });
    writeToken();

    await setup(docker, { force: true });

    expect((await docker.inspectService(PANEL_SWARM_SERVICE))?.spec.TaskTemplate.ContainerSpec.Image).toBe(
      IMAGE,
    );
  });

  it("refuses a worker node, and only leaves its Swarm with --force", async () => {
    const worker = new FakeDriver({ swarmWorker: true, tickMs: 1 });

    await expect(setup(worker)).rejects.toThrow(/--force/);
    expect((await worker.swarmInfo()).state).toBe("active");

    writeToken();
    const forced = new FakeDriver({ swarmWorker: true, tickMs: 1 });
    await setup(forced, { force: true });

    expect((await forced.swarmInfo()).isManager).toBe(true);
    expect(await forced.inspectService(PANEL_SWARM_SERVICE)).not.toBeNull();
  });

  it("does not leave a healthy Swarm even with --force", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    const before = await docker.swarmInfo();
    await docker.createService({
      Name: "someone_else",
      TaskTemplate: { ContainerSpec: { Image: "nginx:alpine" } },
      Mode: { Replicated: { Replicas: 1 } },
    });
    writeToken();

    await setup(docker, { force: true });

    expect((await docker.swarmInfo()).nodeId).toBe(before.nodeId);
    expect(await docker.inspectService("someone_else")).not.toBeNull();
  });

  it("refuses a port that another service publishes, with or without --force", async () => {
    for (const force of [false, true]) {
      const docker = new FakeDriver({ tickMs: 1 });
      await docker.createService({
        Name: "reverse_proxy",
        TaskTemplate: { ContainerSpec: { Image: "nginx:alpine" } },
        Mode: { Replicated: { Replicas: 1 } },
        EndpointSpec: { Ports: [{ TargetPort: 80, PublishedPort: 80, PublishMode: "host" }] },
      });

      await expect(setup(docker, { force })).rejects.toThrow(
        /Port 80 is already published by the service "reverse_proxy"/,
      );
      expect(await docker.inspectService("reverse_proxy")).not.toBeNull();
    }
  });

  it("refuses a Docker that is too old before changing anything", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    docker.engine = { ...docker.engine, version: "19.03.0" };

    await expect(setup(docker)).rejects.toThrow(/19\.03\.0.*nothing has been changed/i);
    expect((await docker.swarmInfo()).state).toBe("inactive");
  });

  describe("an engine that says it can't do what the panel needs", () => {
    const refuses = async (arrange: (docker: FakeDriver) => void, reason: RegExp) => {
      const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
      arrange(docker);

      await expect(setup(docker)).rejects.toThrow(reason);

      expect((await docker.swarmInfo()).state, "Swarm was left alone").toBe("inactive");
      expect(existsSync(join(dataDir, "setup-state.json")), "no change was recorded").toBe(false);
    };

    it("is refused for a current version number with an old API, before anything changes", () =>
      refuses((docker) => {
        docker.engine = { ...docker.engine, version: "29.0.0", apiVersion: "1.41" };
      }, /Engine API 1\.41.*nothing has been changed/i));

    it("is refused when it has no overlay driver", () =>
      refuses((docker) => {
        docker.engine = { ...docker.engine, networkDrivers: ["bridge", "host"] };
      }, /no overlay network driver/));

    it("is refused when it has no local volume driver", () =>
      refuses((docker) => {
        docker.engine = { ...docker.engine, volumeDrivers: [] };
      }, /no local volume driver/));

    it("is refused when it has no Swarm mode at all", () =>
      refuses((docker) => {
        docker.engine = { ...docker.engine, swarmAvailable: false };
      }, /no Swarm mode/));

    it("is refused when its CLI has no buildx or Compose, before anything changes", async () => {
      const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
      const tools = new FakeTools();
      tools.missingPlugins.add("buildx");
      tools.missingPlugins.add("compose");

      await expect(setup(docker, {}, { tools })).rejects.toThrow(/buildx.*Compose/s);

      expect((await docker.swarmInfo()).state).toBe("inactive");
    });

    it("doesn't count a Swarm that isn't started yet, since that is what setup does next", async () => {
      const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
      docker.engine = { ...docker.engine, swarm: "inactive", swarmManager: false };
      writeToken();

      await expect(setup(docker)).resolves.toBeDefined();
    });
  });

  it("refuses to run twice at once", async () => {
    writeFileSync(join(dataDir, "setup.lock"), "");

    await expect(setup(new FakeDriver({ swarmActive: false, tickMs: 1 }))).rejects.toThrow(SetupError);
  });

  it("clears a lock left behind by a run that died", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();
    const stale = join(dataDir, "setup.lock");
    writeFileSync(stale, "");
    const longAgo = new Date(Date.now() - 3_600_000);
    (await import("node:fs")).utimesSync(stale, longAgo, longAgo);

    await expect(setup(docker)).resolves.toBeDefined();
  });

  it("says when it picks up after an interrupted run", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();
    writeFileSync(join(dataDir, "setup-state.json"), JSON.stringify({ phase: "network" }));

    await setup(docker);

    expect(log.join("\n")).toContain('during the "network" step');
    expect(JSON.parse(readFileSync(join(dataDir, "setup-state.json"), "utf8")).phase).toBe("complete");
  });

  it("does not call a run it refused interrupted", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    await docker.createService({
      Name: PANEL_SWARM_SERVICE,
      TaskTemplate: { ContainerSpec: { Image: "someone/elses:panel" } },
      Mode: { Replicated: { Replicas: 1 } },
    });

    await expect(setup(docker)).rejects.toThrow(/--force/);

    expect(existsSync(join(dataDir, "setup-state.json"))).toBe(false);
  });

  it("explains a failure to initialize Swarm", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    docker.failNext("swarmInit");

    await expect(setup(docker)).rejects.toThrow(/--advertise-addr/);
  });
});

describe("the server's address", () => {
  const ADDRESS: AddressForProxy = {
    domain: "bcdfghjk.opsifier.dev",
    challenge: {
      namesUrl: "https://names.opsifier.dev",
      id: "bcdfghjk",
      secretFile: "/var/lib/opsifier/traefik/opsifier-address.secret",
    },
  };
  const having = (address: AddressForProxy | null): SetupAddress => ({ ensure: async () => address });

  it("gives the proxy its resolver, and shows the address, when there is one", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();

    const result = await setup(docker, {}, { address: having(ADDRESS) });

    const env = envOf((await docker.inspectService(PROXY_SWARM_SERVICE))?.spec);
    expect(env).toEqual(
      expect.arrayContaining([
        "TRAEFIK_CERTIFICATESRESOLVERS_OPSIFIER_ACME_DNSCHALLENGE_PROVIDER=httpreq",
        "HTTPREQ_ENDPOINT=https://names.opsifier.dev/v1/acme",
        "HTTPREQ_USERNAME=bcdfghjk",
        "HTTPREQ_PASSWORD_FILE=/var/lib/opsifier/traefik/opsifier-address.secret",
      ]),
    );
    expect(result.urls[1]).toMatch(/^https:\/\/panel\.bcdfghjk\.opsifier\.dev\/setup\?token=/);
  });

  it("keeps the HTTP challenge beside it, for domains the owner brings", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();

    await setup(docker, {}, { address: having(ADDRESS) });

    expect(envOf((await docker.inspectService(PROXY_SWARM_SERVICE))?.spec)).toContain(
      "TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_ACME_HTTPCHALLENGE_ENTRYPOINT=web",
    );
  });

  it("falls back to sslip.io when there is no address, and the install still completes", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();

    const result = await setup(docker, { advertiseAddr: "203.0.113.7" }, { address: having(null) });

    expect(result.urls[1]).toContain(".sslip.io");
    expect(
      envOf((await docker.inspectService(PROXY_SWARM_SERVICE))?.spec).some((line) =>
        line.startsWith("HTTPREQ_"),
      ),
    ).toBe(false);
    expect(result.changed).toContain(`created ${PANEL_SWARM_SERVICE}`);
  });

  it("is not stopped by a failure in the address step", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();
    const address: SetupAddress = {
      ensure: async () => {
        throw new Error("Unexpected");
      },
    };

    const result = await setup(docker, {}, { address });

    expect(result.urls[0]).toContain(":3000/setup");
    expect(log.join("\n")).toContain("sslip.io");
    expect(await docker.inspectService(PANEL_SWARM_SERVICE)).not.toBeNull();
  });

  it("is not held up by a step that never answers", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();
    const address: SetupAddress = { ensure: () => new Promise(() => {}) };

    const result = await setup(docker, {}, { address, timing: { addressMs: 10 } });

    expect(result.changed).toContain(`created ${PANEL_SWARM_SERVICE}`);
    expect(log.join("\n")).toContain("took too long");
  });

  it("does not ask for an address until the checks have passed", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    await docker.createService({
      Name: PANEL_SWARM_SERVICE,
      TaskTemplate: { ContainerSpec: { Image: "someone/elses:panel" } },
      Mode: { Replicated: { Replicas: 1 } },
    });
    let asked = false;
    const address: SetupAddress = {
      ensure: async () => {
        asked = true;
        return null;
      },
    };

    await expect(setup(docker, {}, { address })).rejects.toThrow(/--force/);

    expect(asked).toBe(false);
  });

  it("tells the address step about the flag", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();
    let optedOut: boolean | undefined;
    const address: SetupAddress = {
      ensure: async (input) => {
        optedOut = input.optedOut;
        return null;
      },
    };

    await setup(docker, { noOpsifierAddress: true }, { address });

    expect(optedOut).toBe(true);
  });

  it("changes nothing on a second run with the same address", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();
    await setup(docker, {}, { address: having(ADDRESS) });
    const before = await docker.inspectService(PROXY_SWARM_SERVICE);

    const second = await setup(docker, {}, { address: having(ADDRESS) });

    expect(second.changed).toEqual([]);
    expect((await docker.inspectService(PROXY_SWARM_SERVICE))?.version).toBe(before?.version);
  });

  it("adds the resolver to a proxy from before there was an address", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();
    await setup(docker, {}, { address: having(null) });

    const second = await setup(docker, {}, { address: having(ADDRESS) });

    expect(second.changed).toEqual([`updated ${PROXY_SWARM_SERVICE}`]);
    expect(envOf((await docker.inspectService(PROXY_SWARM_SERVICE))?.spec)).toContain(
      "HTTPREQ_USERNAME=bcdfghjk",
    );
  });

  it("passes on a moved service, so the panel asks the same one", async () => {
    const docker = new FakeDriver({ swarmActive: false, tickMs: 1 });
    writeToken();

    await setup(docker, { namesUrl: "https://names.example" }, { address: having(null) });

    expect(envOf((await docker.inspectService(PANEL_SWARM_SERVICE))?.spec)).toContain(
      "OPSIFIER_NAMES_URL=https://names.example",
    );
  });
});

describe("the installer", () => {
  const script = readFileSync(
    join(import.meta.dirname, "..", "..", "..", "..", "scripts", "install.sh"),
    "utf8",
  );

  it("documents the flag inside the lines --help prints", () => {
    const range = /sed -n '2,(\d+)p'/.exec(script);
    const help = script.split("\n").slice(1, Number(range?.[1]));

    expect(help.join("\n")).toContain("--no-opsifier-address");
    expect(help.join("\n")).toContain("Running it again");
    expect(help.join("\n")).not.toContain("set -euo pipefail");
  });

  it("passes the flag on to setup", () => {
    expect(script).toContain("args+=(--no-opsifier-address)");
  });

  it("can undo an install that stopped partway, and only with --yes", () => {
    const range = /sed -n '2,(\d+)p'/.exec(script);
    const help = script.split("\n").slice(1, Number(range?.[1])).join("\n");

    expect(help).toContain("--clean-up");
    expect(help).toContain("--yes");
    expect(script).toContain("local args=(clean-setup)");
    expect(script).toMatch(/\[ "\$yes" = false \] \|\| args\+=\(--yes\)/);
    expect(script).toContain("--clean-up removes what it made");
  });
});

describe("the service specs", () => {
  const inputs = { dataDir: "/var/lib/opsifier", image: IMAGE, networkId: "abc" };

  it("runs both on a manager node, restarting whatever happens", () => {
    for (const spec of [
      proxyServiceSpec(inputs),
      panelServiceSpec({ ...inputs, trustedProxies: ["10.0.1.0/24"] }),
    ]) {
      expect(spec.TaskTemplate.Placement?.Constraints).toEqual(["node.role==manager"]);
      expect(spec.TaskTemplate.RestartPolicy?.Condition).toBe("any");
      expect(spec.UpdateConfig).toMatchObject({ Order: "stop-first" });
    }
  });

  it("lets the panel fall back to the version it replaced", () => {
    const spec = panelServiceSpec({ ...inputs, trustedProxies: ["10.0.1.0/24"] });

    expect(spec.UpdateConfig).toMatchObject({ FailureAction: "rollback" });
    expect(spec.RollbackConfig).toMatchObject({ FailureAction: "pause" });
  });

  it("gives Traefik its entry points and the panel's files as its only provider", () => {
    const env = envOf(proxyServiceSpec(inputs));

    expect(env).toContain("TRAEFIK_ENTRYPOINTS_WEB_ADDRESS=:80");
    expect(env).toContain("TRAEFIK_ENTRYPOINTS_WEBSECURE_ADDRESS=:443");
    expect(env).toContain("TRAEFIK_PROVIDERS_FILE_DIRECTORY=/var/lib/opsifier/traefik/dynamic");
  });
});

describe("the command line", () => {
  it("reads flags in both spellings", () => {
    expect(
      parseArgs(["--image", "a:b", "--force", "--advertise-addr=10.1.2.3", "--server-ip", "1.2.3.4"]),
    ).toEqual({ force: true, help: false, image: "a:b", advertiseAddr: "10.1.2.3", serverIp: "1.2.3.4" });
  });

  it("reads the flag that turns the address off", () => {
    expect(parseArgs(["--no-opsifier-address"]).noOpsifierAddress).toBe(true);
    expect(parseArgs([]).noOpsifierAddress).toBeUndefined();
  });

  it("reads the confirmation that clean-setup needs", () => {
    expect(parseArgs(["--yes"]).yes).toBe(true);
    expect(parseArgs([]).yes).toBeUndefined();
  });

  it("refuses anything it doesn't know", () => {
    expect(() => parseArgs(["--destroy-everything"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["--image"])).toThrow(/needs a value/);
  });
});

describe("going back from outside the panel", () => {
  async function installedAfterUpdate(docker: FakeDriver) {
    await docker.createService(
      panelServiceSpec({
        dataDir,
        image: "ghcr.io/example/opsifier:2.0.0",
        networkId: "n",
        trustedProxies: ["10.0.0.0/24"],
      }),
    );
    docker.advance(8);
    mkdirSync(join(dataDir, "panel-update", "snapshots", "snap"), { recursive: true });
    writeFileSync(
      join(dataDir, "panel-update", "snapshots", "snap", "opsifier.db"),
      "state before the update",
    );
    writeFileSync(join(dataDir, "opsifier.db"), "state after the update");
    writeJournal(
      { dataDir },
      {
        id: "j",
        actionId: null,
        kind: "update",
        state: "succeeded",
        fromVersion: "1.0.0",
        fromImage: "ghcr.io/example/opsifier:1.0.0",
        toVersion: "2.0.0",
        toImage: "ghcr.io/example/opsifier:2.0.0",
        digest: null,
        sizeBytes: null,
        snapshotId: "snap",
        migrationsAtSnapshot: 3,
        restoreData: false,
        startedAt: "2026-11-08T00:00:00.000Z",
        finishedAt: "2026-11-08T00:01:00.000Z",
        error: null,
        concluded: true,
      },
    );
  }

  it("stops the panel, restores the state and starts the old image", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    await installedAfterUpdate(docker);
    docker.addLocalImage("ghcr.io/example/opsifier:1.0.0");
    const stop = pump(docker);
    try {
      await runRollback({ docker, dataDir, log: (line) => log.push(line), pollMs: 1, timeoutMs: 2000 });
    } finally {
      stop();
    }

    expect((await docker.inspectService(PANEL_SWARM_SERVICE))?.spec.TaskTemplate.ContainerSpec.Image).toBe(
      "ghcr.io/example/opsifier:1.0.0",
    );
    expect((await docker.inspectService(PANEL_SWARM_SERVICE))?.spec.Mode?.Replicated?.Replicas).toBe(1);
    expect(readFileSync(join(dataDir, "opsifier.db"), "utf8")).toBe("state before the update");
    expect(readJournal({ dataDir })?.state).toBe("rolled-back");
  });

  it("refuses before stopping anything when the old image is not on this server", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    await installedAfterUpdate(docker);

    await expect(runRollback({ docker, dataDir, log: () => {}, pollMs: 1 })).rejects.toThrow(
      /no longer on this server/,
    );

    expect((await docker.inspectService(PANEL_SWARM_SERVICE))?.spec.Mode?.Replicated?.Replicas).toBe(1);
  });

  it("refuses when no update has been applied", async () => {
    const docker = new FakeDriver({ tickMs: 1 });

    await expect(runRollback({ docker, dataDir, log: () => {}, pollMs: 1 })).rejects.toThrow(
      /no update to go back/,
    );
  });
});
