import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { SystemInfo } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { getSetting, putSetting } from "./repo";

export const SERVER_IP_KEY = "server_ip";

function firstInterfaceAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }
  return null;
}

export async function detectServerIp(deps: Pick<AppDeps, "docker" | "logger">): Promise<string | null> {
  try {
    const swarm = await deps.docker.swarmInfo();
    if (swarm.nodeAddr !== null && isIP(swarm.nodeAddr) !== 0) {
      return swarm.nodeAddr;
    }
  } catch (error) {
    deps.logger.warn({ err: error }, "Could not read the Swarm address");
  }
  return firstInterfaceAddress();
}

/**
 * Settles the stored server IP at boot: a configured address wins, otherwise a stored one is
 * kept, otherwise it is detected. Nothing leaves the server to find out.
 */
export async function ensureServerIp(deps: AppDeps): Promise<void> {
  const configured = deps.config.serverIp;
  if (configured !== undefined) {
    putSetting(deps.db, SERVER_IP_KEY, configured, new Date(deps.now()));
    return;
  }
  if (typeof getSetting(deps.db, SERVER_IP_KEY) === "string") {
    return;
  }
  const detected = await detectServerIp(deps);
  if (detected !== null) {
    putSetting(deps.db, SERVER_IP_KEY, detected, new Date(deps.now()));
  } else {
    deps.logger.warn("Could not determine the server IP");
  }
}

export function getSystemInfo(deps: AppDeps): SystemInfo {
  const stored = getSetting(deps.db, SERVER_IP_KEY);
  return {
    version: deps.config.version,
    serverIp: typeof stored === "string" && isIP(stored) !== 0 ? stored : null,
    simulated: deps.docker.kind === "fake",
  };
}
