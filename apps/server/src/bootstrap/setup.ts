import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  cliProblems,
  type DockerDriver,
  DockerDriverError,
  engineProblems,
  type NetworkInfo,
  type ServiceInfo,
  type SwarmInfo,
  type SwarmServiceSpec,
} from "../core/docker";
import type { ToolRunner } from "../core/tools";
import { addressChallengeEnv } from "../features/opsifier-address/proxy-env";
import type { AddressForProxy, SetupAddress } from "./address";
import { LOCK_FILE, readRecord, SETUP_RUN_LABEL, SetupLedger } from "./ledger";
import {
  converge,
  HTTP_PORT,
  HTTPS_PORT,
  MANAGED_LABEL,
  PANEL_PORT,
  PANEL_SWARM_SERVICE,
  PROXY_IMAGE,
  PROXY_SWARM_SERVICE,
  panelEnv,
  panelServiceSpec,
  proxyServiceSpec,
  SHARED_NETWORK,
} from "./specs";

const OWN_SERVICES = [PANEL_SWARM_SERVICE, PROXY_SWARM_SERVICE];
const OWN_PORTS = [HTTP_PORT, HTTPS_PORT, PANEL_PORT];

export class SetupError extends Error {
  override readonly name = "SetupError";
}

export interface SetupOptions {
  /** Allows replacing or leaving what is already there. Never implied by anything else. */
  force: boolean;
  /** The address other Swarm nodes reach this one on. Docker picks one when it can. */
  advertiseAddr?: string;
  /** The address people reach the panel on, when it isn't the advertised one, as behind NAT. */
  serverIp?: string;
  image: string;
  /** `OPSIFIER_NAMES_URL` as it was given, to hand on to the panel. */
  namesUrl?: string;
}

export interface SetupTiming {
  pollMs: number;
  /** How long a service may take to get a running task. */
  startupMs: number;
  /** How long a task may take to write the one-time code once it is up. */
  tokenWaitMs: number;
  lockStaleMs: number;
  /** The most the address step may take, whatever it is doing. An install never waits longer on it. */
  addressMs: number;
}

const DEFAULT_TIMING: SetupTiming = {
  pollMs: 1000,
  startupMs: 5 * 60_000,
  tokenWaitMs: 30_000,
  lockStaleMs: 2 * 60_000,
  addressMs: 12_000,
};

export interface SetupDeps {
  docker: DockerDriver;
  /** Runs the Docker CLI to see which of its plugins are there. */
  tools: ToolRunner;
  /** The environment the Docker CLI needs to find its plugins and the daemon. */
  dockerEnv: Readonly<Record<string, string>>;
  dataDir: string;
  setupTokenFile: string;
  log(line: string): void;
  timing?: Partial<SetupTiming>;
  /** True when something else is listening on this port. Injected so tests don't bind real ones. */
  isPortTaken?(port: number): Promise<boolean>;
  /** Registers the server, or finds what it already has. Absent, generated names stay on sslip.io. */
  address?: SetupAddress;
}

export interface SetupResult {
  /** Where to go next. The first is the one that works without DNS or a certificate. */
  urls: string[];
  /** False when the panel already has an administrator, and the URLs carry no code. */
  firstRun: boolean;
  serverAddress: string | null;
  changed: string[];
}

/** One run at a time, so two bootstraps can never race to create the panel. */
export function acquireLock(file: string, staleMs: number): () => void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      closeSync(openSync(file, "wx", 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) {
        throw error;
      }
      const age = Date.now() - statSync(file).mtimeMs;
      if (age < staleMs) {
        throw new SetupError(
          `Another setup is already running on this server. If that is wrong, wait ${Math.ceil((staleMs - age) / 1000)} seconds and run it again.`,
        );
      }
      rmSync(file, { force: true });
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    try {
      utimesSync(file, now, now);
    } catch {
      // The lock only matters while it exists. Losing it to a clean-up changes nothing here.
    }
  }, staleMs / 4);
  heartbeat.unref();
  return () => {
    clearInterval(heartbeat);
    rmSync(file, { force: true });
  };
}

/** Everything that would stop a run, found before the first change. Only the checks can fail cleanly. */
async function assertNothingInTheWay(options: SetupOptions, deps: SetupDeps): Promise<void> {
  if (options.force) {
    return;
  }
  for (const name of OWN_SERVICES) {
    const existing = await deps.docker.inspectService(name);
    if (existing !== null && !isOwned(existing)) {
      throw new SetupError(
        `A service named "${name}" already exists and was not created by Opsifier. Remove it, or pass --force to replace it. Nothing has been changed.`,
      );
    }
  }
  const network = await deps.docker.inspectNetwork(SHARED_NETWORK);
  if (network !== null && (network.driver !== "overlay" || !network.attachable)) {
    throw new SetupError(
      `A network named "${SHARED_NETWORK}" already exists and is not an attachable overlay. Remove it, or pass --force to replace it. Nothing has been changed.`,
    );
  }
}

function isOwned(service: ServiceInfo): boolean {
  return service.spec.Labels?.[MANAGED_LABEL] === "true";
}

/** Everything Docker has to be able to do, found before anything changes. Only this can fail cleanly. */
async function assertDockerUsable(deps: SetupDeps): Promise<void> {
  try {
    await deps.docker.ping();
  } catch (error) {
    throw new SetupError(
      `Docker does not answer. Is the socket mounted? ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const engine = await deps.docker.engineInfo();
  const problems = [
    ...engineProblems(engine, { settingUp: true }),
    ...(await cliProblems({ tools: deps.tools, env: deps.dockerEnv })),
  ];
  if (problems.length > 0) {
    throw new SetupError(
      `Docker can't run Opsifier here. ${problems.map(({ message }) => message).join(" ")} Upgrade or repair Docker first: nothing has been changed.`,
    );
  }
  deps.log(`Docker ${engine.version} (API ${engine.apiVersion}) on ${engine.operatingSystem}`);
}

function describeSwarm(swarm: SwarmInfo): string {
  if (swarm.state === "active") {
    return "This node belongs to a Swarm as a worker, so it cannot run the panel.";
  }
  return `This node's Swarm is in the state "${swarm.state}".`;
}

async function initSwarm(options: SetupOptions, deps: SetupDeps, ledger: SetupLedger): Promise<SwarmInfo> {
  deps.log("Initializing Swarm");
  const entry = ledger.intend({ kind: "swarm", nodeId: null });
  try {
    await deps.docker.swarmInit(
      options.advertiseAddr === undefined ? {} : { advertiseAddr: options.advertiseAddr },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SetupError(
      `Swarm could not be initialized: ${detail}${options.advertiseAddr === undefined ? " Pass --advertise-addr with this server's address." : ""}`,
    );
  }
  const swarm = await deps.docker.swarmInfo();
  ledger.made(entry, { nodeId: swarm.nodeId });
  return swarm;
}

/** An existing Swarm is kept as it is: leaving one is only ever a deliberate choice. */
async function ensureSwarm(options: SetupOptions, deps: SetupDeps, ledger: SetupLedger): Promise<SwarmInfo> {
  const current = await deps.docker.swarmInfo();
  if (current.state === "active" && current.isManager) {
    deps.log(`Keeping the existing Swarm (${current.nodeAddr ?? "this node"})`);
    return current;
  }
  if (current.state === "inactive") {
    return initSwarm(options, deps, ledger);
  }
  if (!options.force) {
    throw new SetupError(
      `${describeSwarm(current)} Fix that, or pass --force to leave that Swarm and start a new one. Nothing has been changed.`,
    );
  }
  deps.log("Leaving the existing Swarm (--force)");
  await deps.docker.swarmLeave({ force: true });
  return initSwarm(options, deps, ledger);
}

/** Anything that publishes our ports and is not ours will keep Traefik or the panel from starting. */
async function assertPortsAvailable(
  deps: SetupDeps,
  proxyExists: boolean,
  panelExists: boolean,
): Promise<void> {
  for (const service of await deps.docker.listServices()) {
    if (OWN_SERVICES.includes(service.name)) {
      continue;
    }
    const clash = service.spec.EndpointSpec?.Ports?.find(
      (port) => port.PublishedPort !== undefined && OWN_PORTS.includes(port.PublishedPort),
    );
    if (clash !== undefined) {
      throw new SetupError(
        `Port ${clash.PublishedPort} is already published by the service "${service.name}". Free it and run this again. Nothing has been changed.`,
      );
    }
  }
  const expected = [...(proxyExists ? [] : [HTTP_PORT, HTTPS_PORT]), ...(panelExists ? [] : [PANEL_PORT])];
  for (const port of expected) {
    if (await (deps.isPortTaken ?? isPortTaken)(port)) {
      throw new SetupError(`Port ${port} is already in use on this server. Free it and run this again.`);
    }
  }
}

export function isPortTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EADDRINUSE"));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port, "0.0.0.0");
  });
}

async function ensureNetwork(deps: SetupDeps, ledger: SetupLedger): Promise<NetworkInfo> {
  let network = await deps.docker.inspectNetwork(SHARED_NETWORK);
  if (network !== null && (network.driver !== "overlay" || !network.attachable)) {
    deps.log(`Replacing the network "${SHARED_NETWORK}" (--force)`);
    await deps.docker.removeNetwork(SHARED_NETWORK);
    network = null;
  }
  if (network === null) {
    deps.log(`Creating the "${SHARED_NETWORK}" overlay network`);
    const entry = ledger.intend({ kind: "network", name: SHARED_NETWORK, id: null });
    network = await deps.docker.createNetwork({
      name: SHARED_NETWORK,
      driver: "overlay",
      attachable: true,
      labels: { [MANAGED_LABEL]: "true", [SETUP_RUN_LABEL]: ledger.runId },
    });
    ledger.made(entry, { id: network.id });
  }
  return waitForSubnets(network, deps);
}

/** Swarm allocates a new network's addresses a moment after creating it. */
async function waitForSubnets(network: NetworkInfo, deps: SetupDeps): Promise<NetworkInfo> {
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const deadline = Date.now() + timing.startupMs;
  let current: NetworkInfo | null = network;
  while ((current?.subnets ?? []).length === 0) {
    if (Date.now() >= deadline) {
      throw new SetupError(`Docker reports no address range for the "${SHARED_NETWORK}" network.`);
    }
    await sleep(timing.pollMs);
    current = await deps.docker.inspectNetwork(SHARED_NETWORK);
  }
  return current as NetworkInfo;
}

/**
 * Brings one service to where it needs to be. A service of ours is only touched when something it
 * needs is missing, so a second run restarts nothing; one that isn't ours needs an explicit --force.
 */
async function ensureService(
  wanted: SwarmServiceSpec,
  env: Record<string, string> | undefined,
  network: NetworkInfo,
  deps: SetupDeps,
  changed: string[],
  ledger: SetupLedger,
): Promise<void> {
  const name = wanted.Name;
  let existing = await deps.docker.inspectService(name);

  if (existing !== null && !isOwned(existing)) {
    deps.log(`Replacing the service "${name}" (--force)`);
    await deps.docker.removeService(name);
    await waitForGone(name, deps);
    existing = null;
  }

  if (existing === null) {
    deps.log(`Creating the service "${name}"`);
    const entry = ledger.intend({ kind: "service", name, id: null });
    const created = await deps.docker.createService({
      ...wanted,
      Labels: { ...wanted.Labels, [SETUP_RUN_LABEL]: ledger.runId },
    });
    ledger.made(entry, { id: created.id });
    changed.push(`created ${name}`);
    return;
  }

  const converged = converge(existing.spec, wanted, {
    networkId: network.id,
    networkName: network.name,
    env,
  });
  if (JSON.stringify(converged) === JSON.stringify(existing.spec)) {
    deps.log(`The service "${name}" is already configured`);
    return;
  }
  deps.log(`Updating the service "${name}"`);
  await deps.docker.updateService(name, converged);
  changed.push(`updated ${name}`);
}

export async function waitForGone(name: string, deps: Pick<SetupDeps, "docker" | "timing">): Promise<void> {
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const deadline = Date.now() + timing.startupMs;
  while (Date.now() < deadline) {
    if ((await deps.docker.inspectService(name)) === null) {
      const leftovers = await deps.docker.listTasks({ service: name });
      if (leftovers.every((task) => task.state !== "running")) {
        return;
      }
    }
    await sleep(timing.pollMs);
  }
  throw new SetupError(`The service "${name}" did not go away in time.`);
}

async function waitForRunning(name: string, deps: SetupDeps): Promise<void> {
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const deadline = Date.now() + timing.startupMs;
  let last = "";
  while (Date.now() < deadline) {
    const tasks = await deps.docker.listTasks({ service: name }).catch(() => []);
    const wanted = tasks.filter((task) => task.desiredState === "running");
    if (wanted.length > 0 && wanted.every((task) => task.state === "running")) {
      return;
    }
    const failed = tasks.find((task) => task.state === "failed" || task.state === "rejected");
    last = failed?.error ?? failed?.message ?? wanted[0]?.state ?? last;
    await sleep(timing.pollMs);
  }
  throw new SetupError(`The service "${name}" did not start in time. Last state: ${last || "unknown"}.`);
}

async function pullProxyImage(deps: SetupDeps, ledger: SetupLedger): Promise<void> {
  deps.log(`Pulling ${PROXY_IMAGE}`);
  try {
    if ((await deps.docker.inspectImage(PROXY_IMAGE)) === null) {
      ledger.intend({ kind: "image", ref: PROXY_IMAGE });
    }
    await deps.docker.pullImage(PROXY_IMAGE);
  } catch (error) {
    if (!(error instanceof DockerDriverError)) {
      throw error;
    }
    // Already on the daemon is good enough: Swarm reports a real problem when the task starts.
    deps.log(`Could not pull ${PROXY_IMAGE}: ${error.message}`);
  }
}

function readSetupToken(deps: SetupDeps): string | null {
  try {
    return readFileSync(deps.setupTokenFile, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** The panel writes the code at boot, and has finished booting once its task is running. */
async function waitForToken(deps: SetupDeps): Promise<string | null> {
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  const deadline = Date.now() + timing.tokenWaitMs;
  for (;;) {
    const token = readSetupToken(deps);
    if (token !== null) {
      return token;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await sleep(timing.pollMs);
  }
}

const generatedDomain = (ip: string) => `panel.${ip.replaceAll(":", "-")}.sslip.io`;

function buildUrls(ip: string | null, token: string | null, addressDomain: string | null): string[] {
  const suffix = token === null ? "" : `/setup?token=${token}`;
  const named = addressDomain === null ? null : `https://panel.${addressDomain}${suffix}`;
  if (ip === null) {
    return named === null ? [] : [named];
  }
  const direct = `http://${ip.includes(":") ? `[${ip}]` : ip}:${PANEL_PORT}${suffix}`;
  return [direct, named ?? `https://${generatedDomain(ip)}${suffix}`];
}

/**
 * Picks up the address this server already has, or settles for sslip.io. Nothing in here can fail an
 * install or hold it up: a failure of any kind, or a step that takes too long, is the same as having none.
 */
async function resolveAddress(deps: SetupDeps, ledger: SetupLedger): Promise<AddressForProxy | null> {
  if (deps.address === undefined) {
    return null;
  }
  ledger.intend({ kind: "address" });
  const { addressMs } = { ...DEFAULT_TIMING, ...deps.timing };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      deps.log("Address: the address service took too long, so generated names use sslip.io.");
      resolve(null);
    }, addressMs);
  });
  try {
    return await Promise.race([deps.address.ensure({ log: deps.log }), deadline]);
  } catch (error) {
    deps.log(
      `Address: could not read it (${error instanceof Error ? error.message : String(error)}), so generated names use sslip.io.`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Everything `setup` does, in order. Each step leaves what is already right alone. */
export async function runSetup(options: SetupOptions, deps: SetupDeps): Promise<SetupResult> {
  const timing = { ...DEFAULT_TIMING, ...deps.timing };
  mkdirSync(deps.dataDir, { recursive: true, mode: 0o700 });
  const release = acquireLock(join(deps.dataDir, LOCK_FILE), timing.lockStaleMs);
  let ledger: SetupLedger | undefined;
  try {
    const previous = readRecord(deps.dataDir)?.phase;
    if (previous !== undefined && previous !== "complete") {
      deps.log(
        `Picking up an earlier setup that stopped during the "${previous}" step. To undo it instead, run clean-setup.`,
      );
    }
    const changed: string[] = [];

    await assertDockerUsable(deps);
    const swarmBefore = await deps.docker.swarmInfo();
    let proxyBefore: ServiceInfo | null = null;
    let panelBefore: ServiceInfo | null = null;
    if (swarmBefore.state === "active" && swarmBefore.isManager) {
      await assertNothingInTheWay(options, deps);
      [proxyBefore, panelBefore] = await Promise.all([
        deps.docker.inspectService(PROXY_SWARM_SERVICE),
        deps.docker.inspectService(PANEL_SWARM_SERVICE),
      ]);
      await assertPortsAvailable(deps, proxyBefore !== null, panelBefore !== null);
    }

    ledger = SetupLedger.begin(deps.dataDir, options.image);
    ledger.phase("swarm");
    const swarm = await ensureSwarm(options, deps, ledger);

    ledger.phase("network");
    const network = await ensureNetwork(deps, ledger);
    const subnets = network.subnets ?? [];
    deps.log(`Trusting forwarded headers from ${subnets.join(", ")}`);

    mkdirSync(join(deps.dataDir, "traefik", "dynamic"), { recursive: true, mode: 0o755 });
    chmodSync(join(deps.dataDir, "traefik"), 0o755);

    const address = await resolveAddress(deps, ledger);

    ledger.phase("proxy");
    await pullProxyImage(deps, ledger);
    await ensureService(
      proxyServiceSpec({
        dataDir: deps.dataDir,
        image: PROXY_IMAGE,
        networkId: network.id,
        addressChallenge: address?.challenge,
      }),
      address === null ? undefined : addressChallengeEnv(`${deps.dataDir}/traefik`, null, address.challenge),
      network,
      deps,
      changed,
      ledger,
    );

    ledger.phase("panel");
    const panelInputs = {
      dataDir: deps.dataDir,
      image: options.image,
      networkId: network.id,
      trustedProxies: subnets,
      serverIp: options.serverIp,
      namesUrl: options.namesUrl,
    };
    await ensureService(panelServiceSpec(panelInputs), panelEnv(panelInputs), network, deps, changed, ledger);

    ledger.phase("waiting");
    deps.log("Waiting for the proxy and the panel to start");
    await waitForRunning(PROXY_SWARM_SERVICE, deps);
    await waitForRunning(PANEL_SWARM_SERVICE, deps);
    const token = existsSync(deps.setupTokenFile) || panelBefore === null ? await waitForToken(deps) : null;

    ledger.phase("complete");
    const serverAddress = options.serverIp ?? swarm.nodeAddr ?? null;
    return {
      urls: buildUrls(serverAddress, token, address?.domain ?? null),
      firstRun: token !== null,
      serverAddress,
      changed,
    };
  } catch (error) {
    if (ledger !== undefined) {
      deps.log(
        "This setup stopped partway. Run it again to carry on, or run clean-setup to remove what it made.",
      );
    }
    throw error;
  } finally {
    release();
  }
}
