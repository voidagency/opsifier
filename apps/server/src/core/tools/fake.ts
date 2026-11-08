import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnTool, type ToolRequest, type ToolResult, type ToolRunner } from "./runner";

export const FAKE_GIT_SHA = "0123456789abcdef0123456789abcdef01234567";

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

  async run(request: ToolRequest): Promise<ToolResult> {
    this.calls.push(request);
    if (request.command === "bsdtar") {
      return spawnTool(request);
    }
    const handled = await this.handler?.(request);
    if (handled !== undefined) {
      return handled;
    }
    return request.command === "git" ? this.simulateGit(request) : this.simulateBuild(request);
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
    return ok();
  }
}
