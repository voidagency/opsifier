import { mkdir, symlink, writeFile } from "node:fs/promises";
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

/** The base images the simulated builders write down, as the real ones name theirs. */
export const FAKE_NIXPACKS_BASE = "ghcr.io/railwayapp/nixpacks:ubuntu-1745885067";
export const FAKE_RAILPACK_BUILDER = "ghcr.io/railwayapp/railpack-builder:latest";
export const FAKE_RAILPACK_RUNTIME = "ghcr.io/railwayapp/railpack-runtime:latest";

/**
 * Simulates git and the builders, for development without Docker and for tests. Unpacking stays real:
 * the panel relies on it to refuse hostile archives, and a simulation would prove nothing.
 */
export class FakeTools implements ToolRunner {
  readonly kind = "fake";
  /**
   * Every call, in order. A tool the panel runs in a container is there twice: the `docker run` that
   * starts it, then the tool as it runs inside, with only the variables it is given.
   */
  readonly calls: ToolRequest[] = [];
  /** What a simulated checkout contains. */
  checkoutFiles: Record<string, string> = { Dockerfile: "FROM scratch\n" };
  /** Links the simulated checkout leaves in the work tree, by name, to where each points. */
  checkoutLinks: Record<string, string> = {};
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
  /**
   * What a simulated Nixpacks writes as its Dockerfile, asked for its output alone with `--out`. Left
   * unset, one that declares every variable it has, its own and those it was given, as the real one.
   */
  nixpacksDockerfile: string | undefined;
  /** The variables a simulated Nixpacks adds of its own, which it passes to its build with the project's. */
  nixpacksVariables: Record<string, string> = { NIXPACKS_METADATA: "node", NODE_ENV: "production" };
  /** What a simulated `railpack prepare` writes as its plan. */
  railpackPlan: unknown = {
    steps: [{ name: "packages:mise", inputs: [{ image: FAKE_RAILPACK_BUILDER }] }],
    deploy: { base: { image: FAKE_RAILPACK_RUNTIME } },
  };

  async run(request: ToolRequest): Promise<ToolResult> {
    const probe = this.answerProbe(request);
    if (probe !== null) {
      return probe;
    }
    this.calls.push(request);
    if (request.command === "bsdtar") {
      return spawnTool(request);
    }
    const inside = containedRun(request);
    if (inside !== undefined) {
      this.calls.push(inside.request);
    }
    const handled = await this.handler?.(request);
    if (handled !== undefined) {
      if (handled.exitCode === 0) {
        await this.writeBuilderOutput(inside ?? { request });
        this.noteBuiltImage(request);
      }
      return handled;
    }
    if (request.command === "ssh-keyscan") {
      return ok([`${request.args.at(-1)} ${FAKE_HOST_KEY}`]);
    }
    return request.command === "git" ? this.simulateGit(request) : this.simulateBuild(request, inside);
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
      for (const [name, target] of Object.entries(this.checkoutLinks)) {
        const path = join(workTree, name);
        await mkdir(dirname(path), { recursive: true });
        await symlink(target, path);
      }
    }
    return ok();
  }

  private async simulateBuild(request: ToolRequest, inside?: ContainedRun): Promise<ToolResult> {
    request.onLine?.(`Simulating ${request.command} ${request.args.join(" ")}`);
    if (this.buildMs > 0) {
      await sleep(this.buildMs, undefined, { signal: request.signal });
    }
    request.signal?.throwIfAborted();
    const refused = await this.writeBuilderOutput(inside ?? { request });
    if (refused !== undefined) {
      return refused;
    }
    this.noteBuiltImage(request);
    return ok();
  }

  /**
   * What Nixpacks writes when asked for its output alone, and the plan `railpack prepare` writes. In a
   * container, only what lands in a folder it was given reaches the server, and a folder given read-only
   * takes nothing.
   */
  private async writeBuilderOutput({ request, folders }: ContainedRun): Promise<ToolResult | undefined> {
    const outAt = optionValue(request, "--out=");
    const out = outAt === undefined ? undefined : onServer(folders, outAt);
    const planAt = optionValue(request, "--plan-out=");
    const plan = planAt === undefined ? undefined : onServer(folders, planAt);
    for (const [path, place] of [
      [outAt, out],
      [planAt, plan],
    ] as const) {
      if (place?.readOnly === true) {
        return { exitCode: 1, tail: [`${path}: Read-only file system`] };
      }
    }
    if (outAt !== undefined && out !== null && out !== undefined) {
      await this.writeNixpacksOutput(request, outAt, out.path);
    }
    if (plan !== null && plan !== undefined) {
      await writeFile(plan.path, JSON.stringify(this.railpackPlan));
    }
    return undefined;
  }

  /** `.nixpacks/` in `place`, the folder Nixpacks calls `out`. */
  private async writeNixpacksOutput(request: ToolRequest, out: string, place: string): Promise<void> {
    const own = request.args.flatMap((arg, index) =>
      request.args[index - 1] === "--env" ? [[arg, request.env[arg] ?? ""] as const] : [],
    );
    const variables = new Map([...Object.entries(this.nixpacksVariables), ...own]);
    const names = [...variables.keys()].sort();
    const declared =
      names.length === 0
        ? ""
        : `ARG ${names.join(" ")}\nENV ${names.map((name) => `${name}=$${name}`).join(" ")}\n`;
    await mkdir(join(place, ".nixpacks"), { recursive: true });
    await writeFile(
      join(place, ".nixpacks", "Dockerfile"),
      this.nixpacksDockerfile ??
        `FROM ${FAKE_NIXPACKS_BASE}\nWORKDIR /app/\n${declared}COPY . /app/.\nCMD ["npm start"]\n`,
    );
    // What Nixpacks would have run, as it writes it: its words joined with spaces, none of them quoted.
    const words = [
      "docker",
      "build",
      out,
      "-f",
      join(out, ".nixpacks", "Dockerfile"),
      ...names.flatMap((name) => ["--build-arg", `${name}=${variables.get(name)}`]),
    ];
    await writeFile(join(place, ".nixpacks", "build.sh"), `${words.join(" ")}\n`);
  }

  /** A build that succeeded left an image behind, whoever stood in for running it. */
  private noteBuiltImage(request: ToolRequest): void {
    const image = builtImageOf(request);
    if (image !== undefined) {
      this.onImageBuilt?.(image, labelsOf(request));
    }
  }
}

const optionValue = ({ args }: ToolRequest, prefix: string): string | undefined =>
  args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);

/** A folder of the server that `docker run --mount` gives a container, and where the container sees it. */
interface GivenFolder {
  source: string;
  target: string;
  readOnly: boolean;
}

/** A tool as it runs in the container `docker run` starts for it, and the folders it is given. */
interface ContainedRun {
  request: ToolRequest;
  /** Left out for a tool that runs on the server itself, which reaches every folder. */
  folders?: readonly GivenFolder[];
}

/** The fields of one line of CSV, as Docker reads `--mount`: a quoted field may hold commas. */
function csvFields(line: string): string[] {
  const fields: string[] = [];
  let pos = 0;
  for (;;) {
    let field = "";
    if (line[pos] === '"') {
      pos += 1;
      while (pos < line.length && !(line[pos] === '"' && line[pos + 1] !== '"')) {
        field += line[pos];
        pos += line[pos] === '"' ? 2 : 1;
      }
      pos += 1;
    } else {
      const comma = line.indexOf(",", pos);
      const end = comma === -1 ? line.length : comma;
      field = line.slice(pos, end);
      pos = end;
    }
    fields.push(field);
    if (line[pos] !== ",") {
      return fields;
    }
    pos += 1;
  }
}

function givenFolder(mount: string): GivenFolder {
  const folder: GivenFolder = { source: "", target: "", readOnly: false };
  for (const field of csvFields(mount)) {
    const [key = "", ...value] = field.split("=");
    if (key === "source" || key === "src") {
      folder.source = value.join("=");
    } else if (key === "target" || key === "dst" || key === "destination") {
      folder.target = value.join("=");
    } else if (key === "readonly" || key === "ro") {
      folder.readOnly = value.length === 0 || value.join("=") === "true";
    }
  }
  return folder;
}

/**
 * `docker run [options] --entrypoint=<tool> <image> <args>`, as the tool inside sees it: its arguments,
 * the variables passed to it by `--env`, and the folders `--mount` gives it. Every option the panel
 * passes is written `--name=value`, so the image is the first word that is not one.
 */
function containedRun(request: ToolRequest): ContainedRun | undefined {
  if (request.command !== "docker" || request.args[0] !== "run") {
    return undefined;
  }
  const imageAt = request.args.findIndex((arg, index) => index > 0 && !arg.startsWith("-"));
  const options = request.args.slice(1, imageAt === -1 ? undefined : imageAt);
  const entrypoint = options.find((option) => option.startsWith("--entrypoint="));
  if (imageAt === -1 || entrypoint === undefined) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const option of options.filter((each) => each.startsWith("--env="))) {
    const [name = "", ...value] = option.slice("--env=".length).split("=");
    const given = value.length > 0 ? value.join("=") : request.env[name];
    if (given !== undefined) {
      env[name] = given;
    }
  }
  return {
    request: {
      ...request,
      command: entrypoint.slice("--entrypoint=".length),
      args: request.args.slice(imageAt + 1),
      cwd: options.find((option) => option.startsWith("--workdir="))?.slice("--workdir=".length),
      env,
    },
    folders: options
      .filter((option) => option.startsWith("--mount="))
      .map((option) => givenFolder(option.slice("--mount=".length))),
  };
}

/** Where a path a tool writes to is on the server: null when its container keeps it to itself. */
function onServer(
  folders: readonly GivenFolder[] | undefined,
  path: string,
): { path: string; readOnly: boolean } | null {
  if (folders === undefined) {
    return { path, readOnly: false };
  }
  const folder = folders.find(({ target }) => path === target || path.startsWith(`${target}/`));
  return folder === undefined
    ? null
    : { path: folder.source + path.slice(folder.target.length), readOnly: folder.readOnly };
}

/**
 * The image a build command names: `--tag=`, `--name=`, or the argument after `pack build`. Nixpacks
 * given `--out` only writes what it would build, and the container a tool runs in is no image.
 */
function builtImageOf({ command, args }: ToolRequest): string | undefined {
  if (args.some((arg) => arg.startsWith("--out=")) || (command === "docker" && args[0] === "run")) {
    return undefined;
  }
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
