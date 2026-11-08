import { setTimeout as sleep } from "node:timers/promises";
import type { AppDeps } from "../../core/context";
import { DockerLogParser } from "../../core/docker/log-parser";

/** What the panel runs inside a database's container. Secrets travel in `env` and `stdin` only. */
export interface ExecPlan {
  command: string[];
  env?: string[];
  stdin?: string;
}

export interface ExecOutcome {
  /** True when the process exited cleanly and printed the expected marker. */
  ok: boolean;
  output: string;
}

/** Printed by every script's final statement. A script that stops early never reaches it. */
export const SUCCESS_MARKER = "opsifier-ok";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 16 * 1024;

export interface RunExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Runs one command in the service's running task and collects its output. Never throws for a
 * failure of the command itself: only for Docker not running it at all.
 */
export async function runInDatabase(
  deps: Pick<AppDeps, "docker">,
  service: string,
  plan: ExecPlan,
  options: RunExecOptions = {},
): Promise<ExecOutcome> {
  const session = await deps.docker.execAttach({
    service,
    command: plan.command,
    env: plan.env,
    tty: false,
  });

  const parser = new DockerLogParser();
  const lines: string[] = [];
  const collect = (chunk: Buffer) => {
    for (const { line } of parser.push(Buffer.from(chunk))) {
      lines.push(line);
    }
  };
  session.stream.on("data", collect);
  session.stream.on("error", () => {});

  // Closes the write side only: the process sees end of input and keeps writing its output.
  session.stream.end(plan.stdin ?? "");

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exitCode = await Promise.race([
    session.exited().catch(() => null),
    sleep(timeoutMs, "timeout" as const, { signal: options.signal, ref: false }).catch(
      () => "aborted" as const,
    ),
  ]);

  // Let what the stream already holds arrive before reading it.
  await new Promise((resolve) => setImmediate(resolve));
  session.stream.off("data", collect);
  for (const { line } of parser.flush()) {
    lines.push(line);
  }
  if (typeof exitCode === "string") {
    session.stream.destroy();
    return { ok: false, output: truncate(lines.join("\n") || "The command did not finish in time.") };
  }

  const output = truncate(lines.join("\n"));
  return { ok: exitCode === 0 && output.includes(SUCCESS_MARKER), output };
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}...` : text;
}

/**
 * Removes every form a secret could take in a client's output. The scripts are ours, so this only
 * matters for a client that echoes back the statement that failed.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret === "") {
      continue;
    }
    const forms = new Set([
      secret,
      secret.replaceAll("'", "''"),
      secret.replaceAll("\\", "\\\\"),
      secret.replaceAll("\\", "\\\\").replaceAll("'", "\\'"),
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
    ]);
    for (const form of forms) {
      safe = safe.split(form).join("••••");
    }
  }
  return safe;
}
