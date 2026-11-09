import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type AddKnownHostRequest,
  type KnownHost,
  type ScanKnownHostRequest,
  type ScannedHostKey,
  SSH_PUBLIC_KEY,
} from "@opsifier/contract";
import { nanoid } from "nanoid";
import type { AppDeps } from "../../core/context";
import { AppError, badRequest, notFound } from "../../core/errors";
import { ToolNotFoundError } from "../../core/tools";
import { inheritedEnv } from "../service-tabs/source/build/environment";
import { sshFingerprint } from "../service-tabs/source/build/ssh-key";
import {
  deleteHostRow,
  findHostRow,
  findHostRows,
  insertHostRow,
  type KnownHostRow,
  listHostRows,
} from "./repo";

const SCAN_TIMEOUT_MS = 15_000;

const toKnownHost = (row: KnownHostRow): KnownHost => ({
  id: row.id,
  host: row.host,
  port: row.port,
  keyType: row.keyType,
  publicKey: row.publicKey,
  fingerprint: row.fingerprint,
  addedBy: row.addedBy,
  createdAt: row.createdAt.toISOString(),
});

export function listKnownHosts(deps: Pick<AppDeps, "db">): KnownHost[] {
  return listHostRows(deps.db).map(toKnownHost);
}

export function isHostKnown(deps: Pick<AppDeps, "db">, host: string, port: number): boolean {
  return findHostRows(deps.db, host.toLowerCase(), port).length > 0;
}

/** The `known_hosts` lines ssh is given for this host: the registry's keys for it and nothing else. */
export function knownHostLines(deps: Pick<AppDeps, "db">, host: string, port: number): string {
  const name = port === 22 ? host.toLowerCase() : `[${host.toLowerCase()}]:${port}`;
  return findHostRows(deps.db, host.toLowerCase(), port)
    .map((row) => `${name} ${row.keyType} ${row.publicKey}\n`)
    .join("");
}

/** The type named inside the key's own bytes, which has to agree with the one written in front of it. */
function blobKeyType(base64: string): string | null {
  const blob = Buffer.from(base64, "base64");
  if (blob.length < 4) {
    return null;
  }
  const length = blob.readUInt32BE(0);
  return length > 0 && 4 + length <= blob.length ? blob.toString("ascii", 4, 4 + length) : null;
}

function parseHostKey(line: string): { keyType: string; publicKey: string } | null {
  const match = SSH_PUBLIC_KEY.exec(line.trim());
  const keyType = match?.[1];
  const publicKey = match?.[2];
  if (keyType === undefined || publicKey === undefined || blobKeyType(publicKey) !== keyType) {
    return null;
  }
  return { keyType, publicKey };
}

function insertHost(
  deps: Pick<AppDeps, "db" | "now">,
  entry: { host: string; port: number; keyType: string; publicKey: string },
  addedBy: string | null,
): KnownHostRow {
  const row: KnownHostRow = {
    id: nanoid(),
    ...entry,
    fingerprint: sshFingerprint(`${entry.keyType} ${entry.publicKey}`),
    addedBy,
    createdAt: new Date(deps.now()),
  };
  insertHostRow(deps.db, row);
  return row;
}

/** Trusts one key of one host. Somebody decided this after comparing the fingerprint. */
export function addKnownHost(
  deps: Pick<AppDeps, "db" | "now" | "actions">,
  request: AddKnownHostRequest,
  actorEmail: string,
): KnownHost {
  const parsed = parseHostKey(request.publicKey);
  if (parsed === null) {
    throw badRequest("validation_failed", "Some fields need attention.", {
      publicKey: "This is not a public key the panel recognises",
    });
  }
  const row = insertHost(deps, { host: request.host, port: request.port, ...parsed }, actorEmail);
  deps.actions.record({
    type: "server.known-host",
    title: `Trust the ${row.keyType} key of ${row.host}:${row.port}`,
    actorEmail,
  });
  const stored = findHostRows(deps.db, row.host, row.port).find(
    (other) => other.keyType === row.keyType && other.publicKey === row.publicKey,
  );
  return toKnownHost(stored ?? row);
}

/** Taking a key off the list stops Git from connecting to that host unless another of its keys matches. */
export function removeKnownHost(deps: Pick<AppDeps, "db" | "actions">, id: string, actorEmail: string): void {
  const row = findHostRow(deps.db, id);
  if (row === undefined) {
    throw notFound("This entry does not exist.");
  }
  deleteHostRow(deps.db, id);
  deps.actions.record({
    type: "server.known-host",
    title: `Stop trusting the ${row.keyType} key of ${row.host}:${row.port}`,
    actorEmail,
  });
}

/** Reads what the host says it is, for a person to compare. Nothing is saved or trusted by this. */
export async function scanKnownHost(
  deps: Pick<AppDeps, "tools">,
  request: ScanKnownHostRequest,
): Promise<ScannedHostKey[]> {
  let tail: readonly string[];
  try {
    const result = await deps.tools.run({
      command: "ssh-keyscan",
      args: ["-T", "10", "-p", String(request.port), "--", request.host],
      env: inheritedEnv(),
      timeoutMs: SCAN_TIMEOUT_MS,
    });
    tail = result.tail;
  } catch (error) {
    if (error instanceof ToolNotFoundError) {
      throw new AppError(503, "ssh_unavailable", "ssh-keyscan is not installed on this server.");
    }
    throw error;
  }
  const seen = new Set<string>();
  const items: ScannedHostKey[] = [];
  for (const line of tail) {
    if (line.startsWith("#")) {
      continue;
    }
    const parsed = parseHostKey(line);
    if (parsed !== null && !seen.has(parsed.publicKey)) {
      seen.add(parsed.publicKey);
      items.push({ ...parsed, fingerprint: sshFingerprint(`${parsed.keyType} ${parsed.publicKey}`) });
    }
  }
  if (items.length === 0) {
    throw new AppError(502, "ssh_host_unreachable", `Could not read the identity of ${request.host}.`);
  }
  return items;
}

/** `host` or `[host]:port`, the two forms a plain `known_hosts` line starts with. */
function parseHostName(name: string): { host: string; port: number } | null {
  const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/.exec(name);
  const host = bracketed?.[1] ?? name;
  const port = bracketed?.[2] === undefined ? 22 : Number(bracketed[2]);
  return host === "" || host.startsWith("|") || host.includes(",")
    ? null
    : { host: host.toLowerCase(), port };
}

/**
 * Before this registry existed, each service remembered hosts on first contact. Those keys are moved
 * here once, so that what connected before an upgrade keeps connecting, and the files are removed.
 */
export async function importLearnedHosts(deps: AppDeps): Promise<void> {
  const projectsDir = join(deps.config.dataDir, "projects");
  const projects = await readdir(projectsDir).catch(() => [] as string[]);
  for (const project of projects) {
    const servicesInProject = await readdir(join(projectsDir, project)).catch(() => [] as string[]);
    for (const service of servicesInProject) {
      const file = join(projectsDir, project, service, "known_hosts");
      const content = await readFile(file, "utf8").catch(() => null);
      if (content === null) {
        continue;
      }
      for (const line of content.split("\n")) {
        const [name, ...rest] = line.trim().split(/\s+/);
        const parsed = parseHostKey(rest.join(" "));
        const host = name === undefined ? null : parseHostName(name);
        if (parsed !== null && host !== null) {
          insertHost(deps, { ...host, ...parsed }, null);
        }
      }
      await rm(file, { force: true });
    }
  }
}
