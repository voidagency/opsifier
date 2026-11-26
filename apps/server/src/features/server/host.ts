import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { hostname, uptime } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ActionEntry, DiskUsageListing, ServerOverview } from "@opsifier/contract";
import {
  isValidHostname,
  serverConfirmWords,
  type TerminalServerFrame,
  terminalClientFrame,
} from "@opsifier/contract";
import { and, eq } from "drizzle-orm";
import { type RawData, WebSocket } from "ws";
import { type ActionContext, type ActionRow, toActionEntry } from "../../core/actions";
import { HOST_ADMIN_ONLY, holdsHostAdmin } from "../../core/auth";
import type { AppDeps } from "../../core/context";
import { actions, domains } from "../../core/db/schema";
import { DockerDriverError, type ExecSession } from "../../core/docker";
import { badRequest, conflict } from "../../core/errors";
import { sslipBase } from "../../core/proxy/sslip";
import type { SocketAdmission, SocketRoute } from "../../core/realtime";
import { isPrivateAddress } from "../notifications/destinations";
import { releasesKept } from "../releases/service";
import { rewriteAllRoutes } from "../service-tabs/domains/changes";
import { getSetting, putSetting } from "../system/repo";
import { detectServerIp, SERVER_IP_KEY } from "../system/service";
import { needsTwoFactorSetup } from "../two-factor-policy/service";
import { directorySize, helperImage, PANEL_SERVICE } from "./disk";
import { readDockerEngine } from "./docker-admin";
import { isReservedForPanel } from "./panel-host";
import { proxyStatus } from "./proxy";
import { getDailyCleanup, writePanelRoutes } from "./settings";

const MAX_LISTING_ENTRIES = 500;
const MAX_FRAME_BYTES = 64 * 1024;
const HOST_CONSOLE_PATH = "/api/v1/terminal/host";

/** The server's own record of its reboots: written by the helper, it needs no panel or database. */
const REBOOT_LOG_FILE = "host-reboots.log";
/** A reboot that was accepted brings the server down well within this. */
const REBOOT_WAIT_MS = 180_000;
/** Fixed text: the log's path and the name of who asked arrive as arguments, never in the script. */
export const REBOOT_SCRIPT = `log=$1
by=$2
note() { printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$log"; }
note "Reboot requested by $by"
if /sbin/reboot; then
  note "Reboot accepted by the system"
else
  code=$?
  note "Reboot failed with code $code"
  exit "$code"
fi`;

export async function isPanelManaged(deps: Pick<AppDeps, "docker">): Promise<boolean> {
  try {
    return (await deps.docker.inspectService(PANEL_SERVICE)) !== null;
  } catch (error) {
    if (error instanceof DockerDriverError) {
      return false;
    }
    throw error;
  }
}

export async function getServerOverview(deps: AppDeps): Promise<ServerOverview> {
  let uptimeSeconds: number | null = null;
  try {
    uptimeSeconds = Math.floor(uptime());
  } catch {
    uptimeSeconds = null;
  }
  const [docker, proxy, managed] = await Promise.all([
    readDockerEngine(deps),
    proxyStatus(deps),
    isPanelManaged(deps),
  ]);
  return {
    hostname: hostname(),
    uptimeSeconds,
    dailyCleanup: getDailyCleanup(deps),
    releasesKept: releasesKept(deps),
    panel: { version: deps.config.version, managed },
    proxy: { state: proxy },
    docker,
  };
}

function assertConfirmed(confirm: string, word: string): void {
  if (confirm !== word) {
    throw conflict("confirmation_mismatch", `Type ${word} to confirm.`, { confirm: "Does not match" });
  }
}

/** Replaces the panel's task. The new process picks the Action up again and closes it. */
export async function enqueuePanelRestart(
  deps: AppDeps,
  confirm: string,
  actorEmail: string | undefined,
): Promise<ActionRow> {
  assertConfirmed(confirm, serverConfirmWords.panelRestart);
  if (!(await isPanelManaged(deps))) {
    throw conflict(
      "panel_not_managed",
      "The panel does not run as a Swarm service here, so it can't restart itself.",
    );
  }
  return deps.actions.enqueue({
    type: "panel.restart",
    title: "Restart the panel",
    actorEmail,
    run: async (ctx) => {
      const panel = await deps.docker.inspectService(PANEL_SERVICE);
      if (panel === null) {
        throw new Error("The panel does not run as a Swarm service here, so it cannot restart itself.");
      }
      ctx.log("Replacing the panel's task");
      await deps.docker.updateService(PANEL_SERVICE, {
        ...panel.spec,
        TaskTemplate: {
          ...panel.spec.TaskTemplate,
          ForceUpdate: (panel.spec.TaskTemplate.ForceUpdate ?? 0) + 1,
        },
      });
      ctx.handOver();
    },
  });
}

/** The panel's Action is left `running` by a restart, and finished here by the panel that follows. */
export function concludeRestarts(deps: AppDeps): void {
  deps.actions.claimInterrupted((row) => row.type === "panel.restart" && row.status === "running");
}

export function finishInterruptedRestarts(deps: AppDeps, rows: readonly ActionRow[]): void {
  for (const row of rows) {
    deps.actions.conclude(row.id, { status: "succeeded" });
  }
}

/** Addresses no one reaches a server on: none, the server itself, its link, a group, or a reserved range. */
const unreachable = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  unreachable.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  unreachable.addSubnet(address, prefix, "ipv6");
}

/** One way of writing each address, IPv6 in lower case with its zeros left out, since names are made from it. */
export function canonicalIp(ip: string): string {
  return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;
}

/**
 * Why names can't be made from an address, or null when they can: one nobody reaches a server on, or one
 * whose name on sslip.io would not be a valid hostname.
 */
export function unusableServerIp(ip: string): string | null {
  const family = isIP(ip);
  // An IPv4 address written as IPv6 is checked apart: a BlockList holding ::ffff:0:0/96 refuses every IPv4.
  const mapped = family === 6 && /^::ffff:/i.test(canonicalIp(ip));
  if (family === 0 || mapped || unreachable.check(ip, family === 6 ? "ipv6" : "ipv4")) {
    return "Nobody can reach a server on this address. Enter the IP people reach it on.";
  }
  return isValidHostname(`panel.${sslipBase(ip)}`) ? null : "No valid name can be made from this address.";
}

/**
 * The server's address becomes `next`. The setting and the hostnames generated from the old address move in
 * one transaction, custom ones staying as they are, then the routes are written again: also when nothing
 * changed, which finishes a move that stopped after the database.
 */
async function moveServerIp(deps: AppDeps, next: string): Promise<boolean> {
  const previous = getSetting(deps.db, SERVER_IP_KEY);
  const changed = previous !== next;
  if (changed) {
    const now = new Date(deps.now());
    deps.db.transaction((tx) => {
      putSetting(tx, SERVER_IP_KEY, next, now);
      if (typeof previous !== "string") {
        return;
      }
      // Written the way they were made, IPv6 addresses included.
      const oldBase = `.${sslipBase(previous)}`;
      const newBase = `.${sslipBase(next)}`;
      for (const row of tx.select().from(domains).all()) {
        if (!row.host.endsWith(oldBase)) {
          continue;
        }
        const host = `${row.host.slice(0, -oldBase.length)}${newBase}`;
        // A name the panel now answers on stays the panel's: that domain keeps its old, dead name. The panel's
        // names are read inside the transaction, so they are already those of the new address.
        if (isReservedForPanel({ ...deps, db: tx as unknown as AppDeps["db"] }, host, row.wildcard)) {
          deps.logger.warn(
            { host },
            "A domain was not moved to the server's new address: the panel answers on it",
          );
          continue;
        }
        tx.update(domains).set({ host, updatedAt: now }).where(eq(domains.id, row.id)).run();
      }
    });
  }
  await writePanelRoutes(deps);
  await rewriteAllRoutes(deps);
  return changed;
}

const addressTitle = (changed: boolean, ip: string) =>
  changed ? `Server address is now ${ip}` : `Server address is still ${ip}`;

/**
 * Hostnames generated from the old address follow it. Custom ones are not touched. A private address found
 * on the server never replaces a public one already known: behind NAT, the server only ever sees the first,
 * and the second came from its owner.
 */
export async function refreshServerIp(deps: AppDeps, actorEmail: string | undefined): Promise<ActionEntry> {
  const found = deps.config.serverIp ?? (await detectServerIp(deps));
  if (found === null) {
    throw conflict("server_address_unknown", "The server's address could not be determined.");
  }
  const detected = canonicalIp(found);
  const stored = getSetting(deps.db, SERVER_IP_KEY);
  const keepsPublic =
    deps.config.serverIp === undefined &&
    typeof stored === "string" &&
    isIP(stored) !== 0 &&
    !isPrivateAddress(stored) &&
    isPrivateAddress(detected);
  if (keepsPublic) {
    await moveServerIp(deps, stored);
    return toActionEntry(
      deps.actions.record({
        type: "server.refresh-ip",
        title: `Server address is still ${stored}: the server only sees ${detected}, a private address`,
        actorEmail,
      }),
    );
  }
  const changed = await moveServerIp(deps, detected);
  return toActionEntry(
    deps.actions.record({ type: "server.refresh-ip", title: addressTitle(changed, detected), actorEmail }),
  );
}

/**
 * The address people reach the server on, given by an administrator: a server behind NAT, as most cloud
 * servers are, only sees a private address on its own network, and names generated from it lead nowhere.
 * An address set in the server's configuration wins at every start, so it is changed there instead.
 */
export async function setServerIp(
  deps: AppDeps,
  given: string,
  actorEmail: string | undefined,
): Promise<ActionEntry> {
  if (deps.config.serverIp !== undefined) {
    throw conflict(
      "server_address_configured",
      `The server's configuration sets its address to ${deps.config.serverIp} (OPSIFIER_SERVER_IP). To change it, run the installer again with --server-ip and the new address.`,
    );
  }
  const ip = canonicalIp(given);
  const unusable = unusableServerIp(ip);
  if (unusable !== null) {
    throw badRequest("validation_failed", "Some fields need attention.", { ip: unusable });
  }
  const changed = await moveServerIp(deps, ip);
  return toActionEntry(
    deps.actions.record({ type: "server.set-ip", title: addressTitle(changed, ip), actorEmail }),
  );
}

/** The IP a request's Host header names, if it names one: `1.2.3.4`, `1.2.3.4:3000` or `[2001:db8::1]:3000`. */
export function ipOfHostHeader(header: string | undefined): string | null {
  const value = (header ?? "").trim().toLowerCase();
  const bracketed = /^\[([0-9a-f:.]+)\](?::\d+)?$/.exec(value);
  const candidate = bracketed?.[1] ?? value.replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, "$1");
  return isIP(candidate) === 0 ? null : canonicalIp(candidate);
}

/**
 * At the claim, the address the owner opened the panel at becomes the server's, when it is a public IP and
 * the server only knew a private one, or none: on a cloud server behind NAT, that is the one address known to
 * reach it, and every name generated from it, under sslip.io, then works from the first app. An address that
 * is already public is kept, and one set in the configuration always wins. It never stops the claim.
 */
export async function adoptClaimAddress(
  deps: AppDeps,
  hostHeader: string | undefined,
  actorEmail: string | undefined,
): Promise<void> {
  const ip = ipOfHostHeader(hostHeader);
  if (
    ip === null ||
    isPrivateAddress(ip) ||
    unusableServerIp(ip) !== null ||
    deps.config.serverIp !== undefined
  ) {
    return;
  }
  const stored = getSetting(deps.db, SERVER_IP_KEY);
  if (typeof stored === "string" && isIP(stored) !== 0 && !isPrivateAddress(stored)) {
    return;
  }
  let changed = false;
  try {
    changed = await moveServerIp(deps, ip);
  } catch (error) {
    // The address is taken once the database has it: only writing the routes failed, and the next start or
    // change of address writes them again.
    changed = getSetting(deps.db, SERVER_IP_KEY) === ip && stored !== ip;
    deps.logger.warn(
      { err: error },
      "Took the address the panel was opened at, but could not write its routes",
    );
  }
  if (changed) {
    deps.actions.record({
      type: "server.set-ip",
      title: `Server address is now ${ip}, the address the panel was opened at`,
      actorEmail,
    });
  }
}

function assertSafeDiskPath(path: string): string {
  if (!path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      path: "Use an absolute path with no ..",
    });
  }
  return path.replace(/\/+$/, "") || "/";
}

function parentOf(path: string): string | null {
  if (path === "/") {
    return null;
  }
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function listingOf(
  path: string,
  entries: DiskUsageListing["entries"],
  scope: DiskUsageListing["scope"],
): DiskUsageListing {
  const sorted = entries.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return {
    scope,
    path,
    parent: parentOf(path),
    sizeBytes: sorted.reduce((total, entry) => total + entry.sizeBytes, 0),
    entries: sorted.slice(0, MAX_LISTING_ENTRIES),
    truncated: sorted.length > MAX_LISTING_ENTRIES,
  };
}

async function diskUsageViaHelper(deps: AppDeps, image: string, path: string): Promise<DiskUsageListing> {
  const target = path === "/" ? "/host" : `/host${path}`;
  const result = await deps.docker.runHelper({
    image,
    command: ["du", "-k", "-x", "-d", "1", "--", target],
    binds: ["/:/host:ro"],
  });
  if (result.exitCode !== 0 && result.stdout === "") {
    throw conflict(
      "disk_scan_failed",
      result.stderr.trim().split("\n", 1)[0] || "The folder could not be read.",
    );
  }
  const entries: DiskUsageListing["entries"] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (match === null) {
      continue;
    }
    const full = match[2] as string;
    if (full === target) {
      continue;
    }
    const inner = full.slice("/host".length) || "/";
    entries.push({
      name: inner.slice(inner.lastIndexOf("/") + 1),
      path: inner,
      directory: true,
      sizeBytes: Number(match[1]) * 1024,
    });
  }
  return listingOf(path, entries, "host");
}

async function diskUsageOfDataDir(deps: AppDeps, path: string): Promise<DiskUsageListing> {
  const base = path === "/" ? deps.config.dataDir : join(deps.config.dataDir, path);
  let children: Dirent[];
  try {
    children = await readdir(base, { withFileTypes: true, encoding: "utf8" });
  } catch {
    throw badRequest("validation_failed", "Some fields need attention.", { path: "No such folder" });
  }
  const entries: DiskUsageListing["entries"] = [];
  for (const child of children.slice(0, MAX_LISTING_ENTRIES * 2)) {
    const full = join(base, child.name);
    const directory = child.isDirectory();
    const size = directory
      ? await directorySize(full)
      : child.isFile()
        ? ((await stat(full).catch(() => null))?.size ?? 0)
        : 0;
    entries.push({
      name: child.name,
      path: path === "/" ? `/${child.name}` : `${path}/${child.name}`,
      directory,
      sizeBytes: size,
    });
  }
  return listingOf(path, entries, "data");
}

/** A folder's size at the first level. On a real server it sees the whole host through a helper. */
export async function readDiskUsage(deps: AppDeps, requested: string): Promise<DiskUsageListing> {
  const path = assertSafeDiskPath(requested);
  const image = await helperImage(deps);
  if (image === null) {
    return diskUsageOfDataDir(deps, path);
  }
  return diskUsageViaHelper(deps, image, path);
}

const rebootLogFile = (deps: Pick<AppDeps, "config">) => join(deps.config.dataDir, REBOOT_LOG_FILE);

/**
 * Asks the machine to reboot, from a helper that writes the outcome to the machine's own disk before
 * the panel is gone. The reboot takes the panel down with it, so the Action stays running and the
 * next start says how it went.
 */
export async function rebootHost(
  deps: AppDeps,
  confirm: string,
  actorEmail: string | undefined,
): Promise<ActionEntry> {
  assertConfirmed(confirm, serverConfirmWords.reboot);
  const image = await helperImage(deps);
  if (image === null) {
    throw conflict("host_operations_unavailable", "This panel has no image to run host operations with.");
  }
  return toActionEntry(
    deps.actions.enqueue({
      type: "server.reboot",
      title: "Reboot the server",
      actorEmail,
      run: async (ctx) => {
        const log = rebootLogFile(deps);
        ctx.log(`Asking the server to reboot. It keeps its own record in ${log}`);
        const result = await deps.docker.runHelper({
          image,
          command: [
            "nsenter",
            "-t",
            "1",
            "-m",
            "-u",
            "-i",
            "-n",
            "--",
            "/bin/sh",
            "-c",
            REBOOT_SCRIPT,
            "opsifier-reboot",
            log,
            actorEmail ?? "the panel",
          ],
          privileged: true,
          hostPid: true,
          signal: ctx.signal,
        });
        if (result.exitCode !== 0 && result.exitCode !== null) {
          throw new Error(result.stderr.trim().split("\n", 1)[0] || "The reboot command failed.");
        }
        if (deps.docker.kind === "fake") {
          ctx.log("Simulated: no server was rebooted");
          return;
        }
        ctx.log("The server accepted the reboot and should go down now");
        await sleep(REBOOT_WAIT_MS, undefined, { signal: ctx.signal });
        throw new Error("The reboot command was accepted, but the server did not go down.");
      },
    }),
  );
}

/** A reboot's Action outlives this process: `recover` must leave it for the next start to conclude. */
export function concludeReboots(deps: Pick<AppDeps, "actions">): void {
  deps.actions.claimInterrupted((row) => row.type === "server.reboot" && row.status === "running");
}

/**
 * Says how a reboot went, once the panel is back: the machine's boot time against when the reboot
 * was asked for, and what the helper recorded in the machine's own log.
 */
export async function finishInterruptedReboots(
  deps: AppDeps,
  bootedAt = deps.now() - uptime() * 1000,
): Promise<void> {
  const rows = deps.db
    .select()
    .from(actions)
    .where(and(eq(actions.type, "server.reboot"), eq(actions.status, "running")))
    .all();
  if (rows.length === 0) {
    return;
  }
  const record = await readFile(rebootLogFile(deps), "utf8").catch(() => "");
  for (const row of rows) {
    for (const line of record.trim().split("\n").slice(-3).filter(Boolean)) {
      deps.actions.note(row.id, `Server's record: ${line}`);
    }
    if ((row.startedAt ?? row.createdAt).getTime() < bootedAt) {
      deps.actions.conclude(row.id, { status: "succeeded" });
    } else {
      deps.actions.conclude(row.id, {
        status: "failed",
        error: "The panel restarted, but the server did not reboot.",
      });
    }
  }
}

const refuse = (status: number, code: string, message: string): SocketAdmission => ({
  allowed: false,
  status,
  code,
  message,
});

/**
 * A shell on the host, through a privileged helper that enters the host's namespaces. The helper
 * container is removed as soon as the socket closes, so a closed console cuts the shell too.
 */
function attachHostShell(deps: AppDeps, socket: WebSocket, image: string, actorEmail: string): void {
  let session: ExecSession | null = null;
  let closed = false;

  const send = (frame: TerminalServerFrame) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  };
  const terminate = () => {
    if (session !== null) {
      const ending = session.terminate?.() ?? Promise.resolve(session.stream.destroy());
      session = null;
      ending.catch(() => undefined);
    }
  };

  deps.actions.record({ type: "server.console", title: "Open the server console", actorEmail });

  socket.on("close", () => {
    closed = true;
    terminate();
  });
  socket.on("message", (data: RawData, isBinary) => {
    const current = session;
    if (current === null) {
      return;
    }
    if (isBinary) {
      current.stream.write(data as Buffer);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse((data as Buffer).toString());
    } catch {
      return;
    }
    const frame = terminalClientFrame.safeParse(value);
    if (frame.success && frame.data.t === "resize") {
      current.resize(frame.data.cols, frame.data.rows).catch(() => undefined);
    }
  });

  deps.docker
    .openHelper({
      image,
      command: ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "/bin/sh", "-l"],
      privileged: true,
      hostPid: true,
      hostNetwork: true,
    })
    .then((opened) => {
      if (closed) {
        opened.terminate?.().catch(() => undefined);
        return;
      }
      session = opened;
      send({ t: "ready" });
      opened.stream.on("data", (chunk: Buffer) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(chunk, { binary: true });
        }
      });
      opened.stream.once("end", () => socket.close(1000, "Session ended"));
      opened.stream.once("close", () => socket.close(1000, "Session ended"));
      opened.stream.on("error", () => undefined);
    })
    .catch((error: unknown) => {
      send({ t: "error", message: error instanceof Error ? error.message : "The console could not start." });
      socket.close(1011, "Session failed");
    });
}

/** `/api/v1/terminal/host`. A right of its own, apart from a service's console, and only with a helper image. */
export function createHostConsoleRoute(deps: AppDeps): SocketRoute {
  return {
    matches: (path) => path === HOST_CONSOLE_PATH,
    maxPayload: MAX_FRAME_BYTES,
    admit({ principal }): SocketAdmission {
      if (!holdsHostAdmin(principal.user)) {
        return refuse(403, "host_admin_required", HOST_ADMIN_ONLY);
      }
      // A socket never passes the HTTP routes' check, so the shell asks it itself.
      if (needsTwoFactorSetup(deps.db, principal.user)) {
        return refuse(
          403,
          "two_factor_setup_required",
          "This panel requires two-factor sign-in: turn it on for this account first.",
        );
      }
      return {
        allowed: true,
        connect: (socket) => {
          void helperImage(deps).then((image) => {
            if (image === null) {
              socket.send(
                JSON.stringify({ t: "error", message: "No image is available for host operations." }),
              );
              socket.close(1011, "Unavailable");
              return;
            }
            attachHostShell(deps, socket, image, principal.user.email);
          });
        },
      };
    },
  };
}

export type { ActionContext };
