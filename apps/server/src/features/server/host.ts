import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { hostname, uptime } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ActionEntry, DiskUsageListing, ServerOverview } from "@opsifier/contract";
import { serverConfirmWords, type TerminalServerFrame, terminalClientFrame } from "@opsifier/contract";
import { and, eq } from "drizzle-orm";
import { type RawData, WebSocket } from "ws";
import { type ActionContext, type ActionRow, toActionEntry } from "../../core/actions";
import { HOST_ADMIN_ONLY, holdsHostAdmin } from "../../core/auth";
import type { AppDeps } from "../../core/context";
import { actions, domains } from "../../core/db/schema";
import { DockerDriverError, type ExecSession } from "../../core/docker";
import { badRequest, conflict } from "../../core/errors";
import type { SocketAdmission, SocketRoute } from "../../core/realtime";
import { releasesKept } from "../releases/service";
import { rewriteAllRoutes } from "../service-tabs/domains/changes";
import { getSetting, putSetting } from "../system/repo";
import { detectServerIp, SERVER_IP_KEY } from "../system/service";
import { directorySize, helperImage, PANEL_SERVICE } from "./disk";
import { readDockerEngine } from "./docker-admin";
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

/** Hostnames generated from the old address follow it. Custom ones are not touched. */
export async function refreshServerIp(deps: AppDeps, actorEmail: string | undefined): Promise<ActionEntry> {
  const previous = getSetting(deps.db, SERVER_IP_KEY);
  const detected = deps.config.serverIp ?? (await detectServerIp(deps));
  if (detected === null) {
    throw conflict("server_address_unknown", "The server's address could not be determined.");
  }
  const changed = previous !== detected;
  if (changed) {
    putSetting(deps.db, SERVER_IP_KEY, detected, new Date(deps.now()));
    if (typeof previous === "string") {
      const oldBase = `.${previous}.sslip.io`;
      const now = new Date(deps.now());
      for (const row of deps.db.select().from(domains).all()) {
        if (row.host.endsWith(oldBase)) {
          deps.db
            .update(domains)
            .set({ host: `${row.host.slice(0, -oldBase.length)}.${detected}.sslip.io`, updatedAt: now })
            .where(eq(domains.id, row.id))
            .run();
        }
      }
    }
    await writePanelRoutes(deps);
    await rewriteAllRoutes(deps);
  }
  return toActionEntry(
    deps.actions.record({
      type: "server.refresh-ip",
      title: changed ? `Server address is now ${detected}` : `Server address is still ${detected}`,
      actorEmail,
    }),
  );
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
