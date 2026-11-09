import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnTool, ToolNotFoundError, type ToolRequest, type ToolResult, type ToolRunner } from "./runner";

export const FAKE_GIT_SHA = "0123456789abcdef0123456789abcdef01234567";
/** One line of `ssh-keyscan`, for a host key a test or a development panel can compare. */
const FAKE_HOST_KEY = `ssh-ed25519 ${Buffer.concat([
  Buffer.from([0, 0, 0, 11]),
  Buffer.from("ssh-ed25519"),
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 7),
]).toString("base64")}`;

export type FakeToolHandler = (
  request: ToolRequest,
) => ToolResult | undefined | Promise<ToolResult | undefined>;

const ok = (lines: string[] = []): ToolResult => ({ exitCode: 0, tail: lines });

/**
 * Simulates git and the builders, for development without Docker and for tests. Unpacking stays real:
 * the panel relies on it to refuse hostile archives, and a simulation would prove nothing.
 */
export class FakeTools implements ToolRunner {
  readonly kind = "fake";
  /** Every call, in order. */
  readonly calls: ToolRequest[] = [];
  /** What a simulated checkout contains. */
  checkoutFiles: Record<string, string> = { Dockerfile: "FROM scratch\n" };
  gitSha = FAKE_GIT_SHA;
  /** Runs first. Returning a result replaces the simulation. */
  handler: FakeToolHandler | undefined;
  /** How long a simulated build takes. */
  buildMs = 0;
  /** Versioned builder binaries that are not on this simulated server. */
  readonly notInstalled = new Set<string>();
  /** Plugins of the Docker CLI that do not answer: `buildx` and `compose`. */
  readonly missingPlugins = new Set<string>();
  /** Told about each image a simulated build leaves behind, so that it can exist somewhere. */
  onImageBuilt: ((image: string, labels: Record<string, string>) => void) | undefined;

  async run(request: ToolRequest): Promise<ToolResult> {
    const probe = this.answerProbe(request);
    if (probe !== null) {
      return probe;
    }
    this.calls.push(request);
    if (request.command === "bsdtar") {
      return spawnTool(request);
    }
    const handled = await this.handler?.(request);
    if (handled !== undefined) {
      if (handled.exitCode === 0) {
        this.noteBuiltImage(request);
      }
      return handled;
    }
    if (request.command === "ssh-keyscan") {
      return ok([`${request.args.at(-1)} ${FAKE_HOST_KEY}`]);
    }
    return request.command === "git" ? this.simulateGit(request) : this.simulateBuild(request);
  }

  /** What the panel asks before running a builder or a plugin is not part of what it runs. */
  private answerProbe(request: ToolRequest): ToolResult | null {
    if (request.args.length === 1 && request.args[0] === "--version") {
      if (this.notInstalled.has(request.command)) {
        throw new ToolNotFoundError(request.command);
      }
      return ok();
    }
    const [plugin, verb] = request.args;
    if (
      request.command === "docker" &&
      ((plugin === "buildx" && verb === "inspect") || (plugin === "compose" && verb === "version"))
    ) {
      return this.missingPlugins.has(plugin) ? { exitCode: 1, tail: [`${plugin}: not found`] } : ok();
    }
    return null;
  }

  /** The calls made to one program. */
  callsTo(command: string): ToolRequest[] {
    return this.calls.filter((call) => call.command === command);
  }

  private async simulateGit(request: ToolRequest): Promise<ToolResult> {
    const subcommand = request.args.find((arg) => !arg.startsWith("-"));
    if (subcommand === "rev-parse") {
      request.onLine?.(this.gitSha);
      return ok([this.gitSha]);
    }
    if (subcommand === "checkout") {
      const workTree = request.args
        .find((arg) => arg.startsWith("--work-tree="))
        ?.slice("--work-tree=".length);
      if (workTree === undefined) {
        throw new Error("The simulated checkout needs --work-tree.");
      }
      for (const [name, content] of Object.entries(this.checkoutFiles)) {
        const path = join(workTree, name);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      }
    }
    return ok();
  }

  private async simulateBuild(request: ToolRequest): Promise<ToolResult> {
    request.onLine?.(`Simulating ${request.command} ${request.args.join(" ")}`);
    if (this.buildMs > 0) {
      await sleep(this.buildMs, undefined, { signal: request.signal });
    }
    request.signal?.throwIfAborted();
    this.noteBuiltImage(request);
    return ok();
  }

  /** A build that succeeded left an image behind, whoever stood in for running it. */
  private noteBuiltImage(request: ToolRequest): void {
    const image = builtImageOf(request);
    if (image !== undefined) {
      this.onImageBuilt?.(image, labelsOf(request));
    }
  }
}

/** The image a build command names: `--tag=`, `--name=`, or the argument after `pack build`. */
function builtImageOf({ command, args }: ToolRequest): string | undefined {
  const option = args.find((arg) => arg.startsWith("--tag=") || arg.startsWith("--name="));
  if (option !== undefined) {
    return option.slice(option.indexOf("=") + 1);
  }
  return command === "pack" && args[0] === "build" ? args[1] : undefined;
}

/** What `--label=name=value` flags would write into the image. */
function labelsOf({ args }: ToolRequest): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith("--label=")) {
      const [name = "", ...value] = arg.slice("--label=".length).split("=");
      labels[name] = value.join("=");
    }
  }
  return labels;
}
