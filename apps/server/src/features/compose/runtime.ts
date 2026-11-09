import type { ConsoleTask, LogSearchQuery, LogSearchResult } from "@opsifier/contract";
import type { AppDeps } from "../../core/context";
import { detectLevel } from "../service-runtime/logs";
import { findService } from "../services/repo";
import { readComposeLogs } from "./feeds";
import { composeProject } from "./names";

interface Target {
  projectName: string;
  serviceName: string;
}

/** Whether this service is a stack, so what asks about containers should ask about its children. */
export function isComposeTarget(deps: Pick<AppDeps, "db">, target: Target): boolean {
  return findService(deps.db, target.projectName, target.serviceName)?.spec.compose != null;
}

/** The stack's running containers, in the shape the console's container picker already understands. */
export async function composeConsoleTasks(
  deps: Pick<AppDeps, "docker">,
  target: Target,
): Promise<Array<Omit<ConsoleTask, "programs"> & { image: string }>> {
  const containers = await deps.docker.listComposeContainers(composeProject(target));
  return containers
    .filter((container) => container.state === "running")
    .sort((a, b) => a.child.localeCompare(b.child) || a.number - b.number)
    .map((container) => ({
      id: container.id,
      slot: container.number,
      name: container.name,
      image: container.image,
    }));
}

const SCAN_LINES = 5000;

export async function searchComposeLogs(
  deps: Pick<AppDeps, "db" | "docker" | "logger" | "now" | "secrets">,
  target: Target,
  query: LogSearchQuery,
  signal?: AbortSignal,
): Promise<LogSearchResult> {
  const needle = query.q.toLowerCase();
  const earliest = query.since === undefined ? null : deps.now() - query.since * 1000;
  const lines = await readComposeLogs(deps, target, {
    tail: SCAN_LINES,
    since: earliest === null ? undefined : Math.floor(earliest / 1000),
    signal,
  });
  const matching = lines.filter(
    (line) =>
      (earliest === null || line.at === null || Date.parse(line.at) >= earliest) &&
      (needle === "" || line.line.toLowerCase().includes(needle)) &&
      (query.stream === "all" || line.stream === query.stream) &&
      (query.level === "any" || detectLevel(line.line) === query.level),
  );
  return {
    lines: matching.slice(-query.limit),
    scanned: lines.length,
    truncated: lines.length >= SCAN_LINES || matching.length > query.limit,
  };
}
