import { z } from "zod";
import { servicePath } from "../services";
import { workspaceFolder } from "./box-modules";

export const MAX_BOX_PROCESSES = 16;
const MAX_COMMAND_CHARS = 4096;

const PROCESS_NAME = /^[a-z][a-z0-9-]{0,30}$/;

/** Started by a module, so the names can't be taken. They appear in the status beside the others. */
export const BOX_SYSTEM_PROCESSES = ["nginx", "php-fpm"] as const;

export const boxProcessName = z
  .string()
  .regex(PROCESS_NAME, "Start with a letter, then use lowercase letters, digits and dashes")
  .refine(
    (name) => !(BOX_SYSTEM_PROCESSES as readonly string[]).includes(name),
    "This name belongs to a module",
  );

export const boxProcess = z.object({
  name: boxProcessName,
  /** Run by `/bin/sh`, so it may be a whole pipeline. */
  command: z
    .string()
    .trim()
    .min(1, "Required")
    .max(MAX_COMMAND_CHARS, "This is too long")
    .refine((value) => !value.includes("\0"), "Must not contain a NUL byte"),
  /** Relative to the workspace. */
  directory: workspaceFolder.default("."),
  enabled: z.boolean().default(true),
});
export type BoxProcess = z.infer<typeof boxProcess>;

/** PUT /api/v1/projects/{project}/services/{service}/box/processes */
export const saveBoxProcessesRequest = z.object({
  processes: z
    .array(boxProcess)
    .max(MAX_BOX_PROCESSES, `A box supervises at most ${MAX_BOX_PROCESSES} processes`)
    .refine(
      (processes) => new Set(processes.map(({ name }) => name)).size === processes.length,
      "Two processes have the same name",
    ),
});
export type SaveBoxProcessesRequest = z.input<typeof saveBoxProcessesRequest>;

export const boxProcessPath = servicePath.extend({
  process: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, "This is not a process name"),
});

/**
 * Where a process stands, as the supervisor in its container reports it. `restarting` has exited and is
 * waiting to come back, `disabled` is switched off and `unknown` means the box could not be asked.
 */
export const boxProcessStates = ["running", "restarting", "stopped", "disabled", "unknown"] as const;
export const boxProcessState = z.enum(boxProcessStates);
export type BoxProcessState = z.infer<typeof boxProcessState>;

export const boxProcessStatus = z.object({
  name: z.string(),
  /** Set for what a module started, and which can't be edited here. */
  system: z.boolean(),
  state: boxProcessState,
  restarts: z.number().int().min(0),
  /** What it last exited with. Null until it has. */
  lastExit: z.number().int().nullable(),
  /** Since when it has been in this state. */
  since: z.iso.datetime().nullable(),
});
export type BoxProcessStatus = z.infer<typeof boxProcessStatus>;

/** GET .../box/processes/status: what the supervisor in the running box says. */
export const boxProcessesStatus = z.object({
  /** False when no task is running, or it did not answer: every process then reads `unknown`. */
  reachable: z.boolean(),
  processes: z.array(boxProcessStatus),
});
export type BoxProcessesStatus = z.infer<typeof boxProcessesStatus>;
