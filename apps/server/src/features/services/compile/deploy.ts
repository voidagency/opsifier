import type { DeploySettings } from "@opsifier/contract";
import type { SwarmServiceSpec } from "../../../core/docker";

const NANOS_PER_SECOND = 1_000_000_000;
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

/** What only a shell can act on, unquoted: expansions, pipes, lists, redirections, globs, comments. */
const SHELL_SYNTAX = /[$`\\|&;<>()*?[\]#~\n]/;
/** What a shell still acts on inside double quotes. Inside single quotes, nothing is special. */
const SHELL_SYNTAX_IN_DOUBLE_QUOTES = /[$`\\]/;
/** Words a shell answers itself: there is no program of that name to run without one. */
const SHELL_BUILTINS = new Set([
  ".",
  ":",
  "cd",
  "eval",
  "exec",
  "export",
  "set",
  "source",
  "trap",
  "ulimit",
  "umask",
  "unset",
  "wait",
]);

/** The words of a plain command, or null when it needs a shell to mean what it says. */
function plainCommandWords(command: string): string[] | null {
  const words: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (const character of command) {
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else if (quote === '"' && SHELL_SYNTAX_IN_DOUBLE_QUOTES.test(character)) {
        return null;
      } else {
        word = (word ?? "") + character;
      }
    } else if (SHELL_SYNTAX.test(character)) {
      return null;
    } else if (character === '"' || character === "'") {
      quote = character;
      word = word ?? "";
    } else if (/\s/.test(character)) {
      if (word !== null) {
        words.push(word);
        word = null;
      }
    } else {
      word = (word ?? "") + character;
    }
  }
  if (word !== null) {
    words.push(word);
  }
  const [first] = words;
  return quote !== null || first === undefined || first.includes("=") || SHELL_BUILTINS.has(first)
    ? null
    : words;
}

/**
 * A plain command runs as what it is, so it needs nothing the image doesn't have and the stop signal
 * reaches it. A shell sits in between only for a command that needs one to mean what it says, where
 * it becomes PID 1 and the image has to have one.
 */
function commandFields(command: string): Pick<CompiledDeploy["container"], "Command" | "Args"> {
  const words = plainCommandWords(command);
  return words === null ? { Command: ["/bin/sh"], Args: ["-c", command] } : { Command: words };
}

function containerOptions(settings: DeploySettings): CompiledDeploy["container"] {
  return {
    Init: settings.tiniInit,
    StopGracePeriod: settings.stopGraceSeconds * NANOS_PER_SECOND,
    ...(settings.stopSignal === null ? {} : { StopSignal: settings.stopSignal }),
    ...(settings.command === null ? {} : commandFields(settings.command)),
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
