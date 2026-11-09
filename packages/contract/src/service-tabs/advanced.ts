import { z } from "zod";
import { wholeNumber } from "../common";
import { servicePath } from "../services";

export const MAX_PORTS = 64;

const port = z
  .number()
  .int("Use a port from 1 to 65535")
  .min(1, "Use a port from 1 to 65535")
  .max(65535, "Use a port from 1 to 65535");

/** A port published on the host, beside whatever the proxy routes. */
export const portSpec = z.object({
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
  published: port,
  target: port,
});
export type PortSpec = z.infer<typeof portSpec>;

/** Every Linux capability Docker can grant, plus `ALL`. A misspelt name would only fail at task start. */
export const LINUX_CAPABILITIES = [
  "ALL",
  "AUDIT_CONTROL",
  "AUDIT_READ",
  "AUDIT_WRITE",
  "BLOCK_SUSPEND",
  "BPF",
  "CHECKPOINT_RESTORE",
  "CHOWN",
  "DAC_OVERRIDE",
  "DAC_READ_SEARCH",
  "FOWNER",
  "FSETID",
  "IPC_LOCK",
  "IPC_OWNER",
  "KILL",
  "LEASE",
  "LINUX_IMMUTABLE",
  "MAC_ADMIN",
  "MAC_OVERRIDE",
  "MKNOD",
  "NET_ADMIN",
  "NET_BIND_SERVICE",
  "NET_BROADCAST",
  "NET_RAW",
  "PERFMON",
  "SETFCAP",
  "SETGID",
  "SETPCAP",
  "SETUID",
  "SYSLOG",
  "SYS_ADMIN",
  "SYS_BOOT",
  "SYS_CHROOT",
  "SYS_MODULE",
  "SYS_NICE",
  "SYS_PACCT",
  "SYS_PTRACE",
  "SYS_RAWIO",
  "SYS_RESOURCE",
  "SYS_TIME",
  "SYS_TTY_CONFIG",
  "WAKE_ALARM",
] as const;

const knownCapabilities: ReadonlySet<string> = new Set(LINUX_CAPABILITIES);

const capabilityList = z
  .array(z.string().refine((name) => knownCapabilities.has(name), "Use a capability name such as NET_ADMIN"))
  .max(LINUX_CAPABILITIES.length, "This is too many")
  .refine((names) => new Set(names).size === names.length, "Lists the same capability twice");

const SYSCTL_KEY = /^[a-z0-9_]+(?:\.[A-Za-z0-9_-]+)+$/;
const NAMESPACED_SYSCTL = /^(?:net\.|fs\.mqueue\.|kernel\.(?:msg|sem|shm))/;

/** Docker only sets sysctls that a container's namespaces isolate. Any other name fails at task start. */
const sysctlKey = z
  .string()
  .min(1)
  .max(256, "This is too long")
  .refine(
    (key) => SYSCTL_KEY.test(key) && NAMESPACED_SYSCTL.test(key),
    "Use a namespaced sysctl such as net.core.somaxconn",
  );

const sysctlValue = z
  .string()
  .min(1, "Give this sysctl a value")
  .max(1024, "This is too long")
  .refine((value) => !/[\r\n]/.test(value) && !value.includes("\0"), "Must fit on one line");

/** What a task can be asked to stop with. SIGKILL is left out: it asks nothing and can't be caught. */
export const STOP_SIGNALS = [
  "SIGTERM",
  "SIGINT",
  "SIGQUIT",
  "SIGHUP",
  "SIGUSR1",
  "SIGUSR2",
  "SIGWINCH",
] as const;

export const MAX_STOP_GRACE_SECONDS = 3600;

const MAX_GROUP_ID = 4_294_967_295;

const groupId = z
  .string()
  .regex(/^\d{1,10}$/, "Use numeric group IDs")
  .refine((value) => Number(value) <= MAX_GROUP_ID, "Use numeric group IDs");

/** How a service runs and rolls out. */
export const deploySettings = z
  .object({
    /** Zero is only valid on a stopped service. The route checks that, since it depends on the state. */
    replicas: z
      .number()
      .int("Use a whole number")
      .min(0, "Run at least one replica")
      .max(100, "This is too many")
      .default(1),
    zeroDowntime: z.boolean().default(true),
    tiniInit: z.boolean().default(false),
    command: z
      .string()
      .trim()
      .min(1, "Leave this empty or enter a command")
      .max(4096, "This is too long")
      .refine((command) => !command.includes("\0"), "Can't contain a NUL character")
      .nullable()
      .default(null),
    /** The signal a task is asked to stop with. Null keeps the one the image declares. */
    stopSignal: z.enum(STOP_SIGNALS).nullable().default(null),
    /** How long a task gets to stop after that signal, before it is killed. */
    stopGraceSeconds: z
      .number()
      .int("Use a whole number of seconds")
      .min(0, "Use a whole number of seconds")
      .max(MAX_STOP_GRACE_SECONDS, `Use at most ${MAX_STOP_GRACE_SECONDS} seconds`)
      .default(10),
    capAdd: capabilityList.default([]),
    capDrop: capabilityList.default([]),
    sysctls: z.record(sysctlKey, sysctlValue).default({}),
    groups: z.array(groupId).max(32, "This is too many").default([]),
  })
  .superRefine((value, context) => {
    const added = new Set(value.capAdd);
    if (value.capDrop.some((name) => added.has(name))) {
      context.addIssue({
        code: "custom",
        path: ["capDrop"],
        message: "A capability can't be both added and dropped",
      });
    }
  });
export type DeploySettings = z.infer<typeof deploySettings>;

/** GET /api/v1/projects/{project}/services/{service}/advanced */
export const advancedDocument = z.object({
  deploy: deploySettings,
  ports: z.array(portSpec),
  /** A stopped service may be set to zero replicas. A running one needs at least one. */
  stopped: z.boolean(),
});
export type AdvancedDocument = z.infer<typeof advancedDocument>;

/** One published port of a service, by its position in the list. */
export const portItemPath = servicePath.extend({ index: wholeNumber(0, 999) });

/** The answer to every change of a service's published ports. */
export const portList = z.object({ ports: z.array(portSpec) });
export type PortList = z.infer<typeof portList>;

/** Comma-separated text as typed in a form, without its blanks. */
export function splitList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/**
 * Comma-separated `key=value` text. A piece with no `=` continues the value before it, so that a list
 * value like `net.ipv4.ip_local_reserved_ports=8080,9148` is kept whole.
 */
export function parseSysctlText(text: string): Record<string, string> {
  const pairs: string[] = [];
  for (const piece of splitList(text)) {
    if (piece.includes("=") || pairs.length === 0) {
      pairs.push(piece);
    } else {
      pairs[pairs.length - 1] = `${pairs[pairs.length - 1]},${piece}`;
    }
  }
  return Object.fromEntries(
    pairs.map((pair) => {
      const separator = pair.indexOf("=");
      return separator === -1
        ? [pair, ""]
        : [pair.slice(0, separator).trim(), pair.slice(separator + 1).trim()];
    }),
  );
}
