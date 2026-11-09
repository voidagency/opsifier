import {
  BOX_SYSTEM_PROCESSES,
  type BoxProcessesStatus,
  type BoxProcessState,
  type BoxProcessStatus,
} from "@opsifier/contract";
import type { ActionContext, ActionRow } from "../../../core/actions";
import type { AppDeps } from "../../../core/context";
import { conflict, notFound } from "../../../core/errors";
import { requireBox } from "../../box/service";
import type { StoredBox } from "../../box/spec";
import { BOX_CONTROL_PATH } from "../../box/supervisor";
import { runInDatabase } from "../../databases/exec";
import { qualifiedName } from "../../services/compile";
import type { ServiceTarget } from "../../services/service";

const STATUS_TIMEOUT_MS = 5000;
const RESTART_TIMEOUT_MS = 20_000;

/** A row of the supervisor's status file: name, state, pid, restarts, last exit, seconds since the epoch. */
interface SupervisorRow {
  state: BoxProcessState;
  restarts: number;
  lastExit: number | null;
  since: string | null;
}

const asState = (value: string): BoxProcessState =>
  value === "running" || value === "restarting" || value === "stopped" ? value : "unknown";

const asCount = (value: string): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

function parseRows(output: string): Map<string, SupervisorRow> {
  const rows = new Map<string, SupervisorRow>();
  for (const line of output.split("\n")) {
    const [name, state, , restarts, lastExit, since] = line.split("\t");
    if (name === undefined || state === undefined || restarts === undefined || since === undefined) {
      continue;
    }
    const seconds = Number(since);
    rows.set(name, {
      state: asState(state),
      restarts: asCount(restarts),
      lastExit: lastExit === undefined || lastExit === "-" ? null : asCount(lastExit),
      since: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
    });
  }
  return rows;
}

/** What a module started, in the order they run. */
function systemProcesses(box: StoredBox): string[] {
  return [
    ...(box.modules.nginx === null ? [] : [BOX_SYSTEM_PROCESSES[0]]),
    ...(box.modules.nginx !== null && box.modules.php !== null ? [BOX_SYSTEM_PROCESSES[1]] : []),
  ];
}

const unknownRow = (name: string, system: boolean): BoxProcessStatus => ({
  name,
  system,
  state: "unknown",
  restarts: 0,
  lastExit: null,
  since: null,
});

/** What the supervisor in the running box says, or that it could not be asked. */
export async function getBoxProcessesStatus(
  deps: AppDeps,
  target: ServiceTarget,
): Promise<BoxProcessesStatus> {
  const { box } = requireBox(deps, target).spec;
  const system = systemProcesses(box);
  let rows: Map<string, SupervisorRow> | null = null;
  try {
    const outcome = await runInDatabase(
      deps,
      qualifiedName(target.projectName, target.serviceName),
      { command: [BOX_CONTROL_PATH, "status"] },
      { timeoutMs: STATUS_TIMEOUT_MS },
    );
    rows = outcome.ok ? parseRows(outcome.output) : null;
  } catch {
    rows = null;
  }

  const report = (name: string, isSystem: boolean): BoxProcessStatus => {
    const row = rows?.get(name);
    return row === undefined ? unknownRow(name, isSystem) : { name, system: isSystem, ...row };
  };
  return {
    reachable: rows !== null,
    processes: [
      ...system.map((name) => report(name, true)),
      ...box.processes.map((process) =>
        process.enabled
          ? report(process.name, false)
          : { ...unknownRow(process.name, false), state: "disabled" as const },
      ),
    ],
  };
}

/** Restarts one process without touching the others, or the task they share. */
export function enqueueBoxProcessRestart(
  deps: AppDeps,
  target: ServiceTarget,
  processName: string,
  actorEmail: string | undefined,
): ActionRow {
  const { box } = requireBox(deps, target).spec;
  const known =
    systemProcesses(box).includes(processName) ||
    box.processes.some(({ name, enabled }) => name === processName && enabled);
  if (!known) {
    throw notFound("This box has no such running process.");
  }
  return deps.actions.enqueue({
    type: "box.process-restart",
    title: `Restart ${processName} in ${target.projectName}/${target.serviceName}`,
    projectName: target.projectName,
    serviceName: target.serviceName,
    actorEmail,
    run: (ctx: ActionContext) => runRestart(deps, target, processName, ctx),
  });
}

async function runRestart(
  deps: AppDeps,
  target: ServiceTarget,
  processName: string,
  ctx: ActionContext,
): Promise<void> {
  const name = qualifiedName(target.projectName, target.serviceName);
  ctx.log(`Restarting ${processName}`);
  let ok: boolean;
  try {
    const outcome = await runInDatabase(
      deps,
      name,
      { command: [BOX_CONTROL_PATH, "restart", processName] },
      { timeoutMs: RESTART_TIMEOUT_MS, signal: ctx.signal },
    );
    ok = outcome.ok;
    if (!ok) {
      ctx.log(outcome.output);
    }
  } catch (error) {
    throw conflict(
      "box_not_running",
      `This box has no running task to do that in: ${(error as Error).message}`,
    );
  }
  if (!ok) {
    throw new Error(`The supervisor could not restart ${processName}.`);
  }
  ctx.log(`Restarted ${processName}`);
}
