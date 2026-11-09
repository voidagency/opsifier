import type { AppDeps } from "../../core/context";
import { assertCliFeature } from "../../core/docker";
import { type Redactor, ToolNotFoundError, type ToolResult } from "../../core/tools";
import { dockerCliEnv } from "../service-tabs/source/build/environment";
import type { ServiceTarget } from "../services/service";
import { composeProject } from "./names";

export interface ComposeFiles {
  /** Relative paths in the file are resolved from here. */
  projectDirectory: string;
  composeFile: string;
  overrideFile: string;
}

export interface ComposeRunOptions {
  /** Omitted for commands that only need the project name, which still work if the files are gone. */
  files?: ComposeFiles;
  /** Variables for interpolation, added to what the Docker CLI needs for itself. */
  variables?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  redact?: Redactor;
  timeoutMs?: number;
}

/** Everything `docker compose` is told about which stack this is. No value here passes through a shell. */
function globalArgs(target: ServiceTarget, files: ComposeFiles | undefined): string[] {
  return [
    "compose",
    "--ansi",
    "never",
    "--project-name",
    composeProject(target),
    ...(files === undefined
      ? []
      : [
          "--project-directory",
          files.projectDirectory,
          "--file",
          files.composeFile,
          "--file",
          files.overrideFile,
        ]),
  ];
}

export async function runCompose(
  deps: Pick<AppDeps, "config" | "docker" | "tools">,
  target: ServiceTarget,
  args: readonly string[],
  options: ComposeRunOptions = {},
): Promise<ToolResult> {
  await assertCliFeature(deps.docker, { tools: deps.tools, env: dockerCliEnv(deps) }, "compose");
  return deps.tools
    .run({
      command: "docker",
      args: [...globalArgs(target, options.files), ...args],
      cwd: options.files?.projectDirectory,
      env: { ...dockerCliEnv(deps), ...options.variables },
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      onLine: options.onLine,
      redact: options.redact,
    })
    .catch((error: unknown) => {
      if (error instanceof ToolNotFoundError) {
        throw new Error("The Docker CLI is not installed on this server.");
      }
      throw error;
    });
}

/** The last things Compose said, for an error someone can act on. */
export function describeComposeFailure(result: ToolResult): string {
  const lines = result.tail.map((line) => line.trim()).filter((line) => line !== "");
  return lines.slice(-3).join(" ").slice(0, 800) || `docker compose exited with ${result.exitCode}.`;
}

export function assertComposeSucceeded(what: string, result: ToolResult): void {
  if (result.exitCode !== 0) {
    throw new Error(`${what} failed: ${describeComposeFailure(result)}`);
  }
}
