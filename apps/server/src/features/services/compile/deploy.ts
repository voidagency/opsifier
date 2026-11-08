import type { DeploySettings } from "@opsifier/contract";
import type { SwarmServiceSpec } from "../../../core/docker";

const NANOS_PER_SECOND = 1_000_000_000;
const STOP_GRACE_NANOS = 10 * NANOS_PER_SECOND;
const RESTART_DELAY_NANOS = 5 * NANOS_PER_SECOND;
const MONITOR_NANOS = 5 * NANOS_PER_SECOND;

export interface DeployInput {
  settings: DeploySettings;
  /** Stopped services run no replicas. */
  stopped: boolean;
  /** Docker's counter: raising it rolls the tasks even when nothing else changed. */
  forceUpdate: number;
  /** A new task can't bind a host port its predecessor still holds, so those must stop first. */
  publishesPorts?: boolean;
}

export interface CompiledDeploy {
  container: Pick<SwarmServiceSpec["TaskTemplate"]["ContainerSpec"], "Command" | "Args"> &
    Record<string, unknown>;
  task: Pick<SwarmServiceSpec["TaskTemplate"], "RestartPolicy" | "ForceUpdate"> & Record<string, unknown>;
  Mode: NonNullable<SwarmServiceSpec["Mode"]>;
  UpdateConfig: Record<string, unknown>;
  RollbackConfig: Record<string, unknown>;
}

const rollingUpdate = (order: "start-first" | "stop-first") => ({
  Parallelism: 1,
  FailureAction: "pause",
  Monitor: MONITOR_NANOS,
  MaxFailureRatio: 0,
  Order: order,
});

function containerOptions(settings: DeploySettings): CompiledDeploy["container"] {
  return {
    Init: settings.tiniInit,
    StopGracePeriod: STOP_GRACE_NANOS,
    ...(settings.command === null ? {} : { Command: ["/bin/sh"], Args: ["-c", settings.command] }),
    ...(settings.capAdd.length > 0 ? { CapabilityAdd: [...settings.capAdd] } : {}),
    ...(settings.capDrop.length > 0 ? { CapabilityDrop: [...settings.capDrop] } : {}),
    ...(Object.keys(settings.sysctls).length > 0 ? { Sysctls: { ...settings.sysctls } } : {}),
    ...(settings.groups.length > 0 ? { Groups: [...settings.groups] } : {}),
  };
}

export function compileDeploy({
  settings,
  stopped,
  forceUpdate,
  publishesPorts = false,
}: DeployInput): CompiledDeploy {
  return {
    container: containerOptions(settings),
    task: {
      RestartPolicy: { Condition: "on-failure", Delay: RESTART_DELAY_NANOS, MaxAttempts: 0 },
      LogDriver: { Name: "json-file", Options: { "max-file": "3", "max-size": "10m" } },
      ForceUpdate: forceUpdate,
    },
    Mode: { Replicated: { Replicas: stopped ? 0 : settings.replicas } },
    UpdateConfig: rollingUpdate(settings.zeroDowntime && !publishesPorts ? "start-first" : "stop-first"),
    RollbackConfig: rollingUpdate("stop-first"),
  };
}
