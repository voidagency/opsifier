import { readFile, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import type { AppDeps } from "../../core/context";
import { type ComposeContainerInfo, FakeDriver } from "../../core/docker";
import { FakeTools, type ToolRequest, type ToolResult } from "../../core/tools";

const ok = (lines: string[] = []): ToolResult => ({ exitCode: 0, tail: lines });

function argument(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** The services a file defines. A simulated stack is what its file says, like a real one. */
async function childrenOf(args: readonly string[]): Promise<string[]> {
  const file = argument(args, "--file");
  if (file === undefined) {
    return [];
  }
  const parsed = parse(await readFile(file, "utf8"), { merge: true }) as {
    services?: Record<string, unknown>;
  };
  return Object.keys(parsed?.services ?? {});
}

/** The labels the generated override gives a child, read back as Docker would report them. */
async function overrideLabels(args: readonly string[], child: string): Promise<Record<string, string>> {
  const override = args.filter((_, index) => args[index - 1] === "--file")[1];
  if (override === undefined) {
    return {};
  }
  const parsed = parse(await readFile(override, "utf8")) as {
    services?: Record<string, { labels?: Record<string, string> }>;
  };
  return parsed.services?.[child]?.labels ?? {};
}

type ComposeFile = {
  services?: Record<string, { networks?: unknown; network_mode?: unknown; [key: string]: unknown }>;
  networks?: Record<string, { name?: string; external?: unknown } | null>;
};

async function filesOf(args: readonly string[]): Promise<ComposeFile[]> {
  const paths = args.filter((_, index) => args[index - 1] === "--file");
  return Promise.all(
    paths.map(async (path) => parse(await readFile(path, "utf8"), { merge: true }) as ComposeFile),
  );
}

/** The docker name of a top-level network, as Compose would resolve it. */
const resolvedName = (project: string, key: string, network: { name?: string; external?: unknown } | null) =>
  network?.name ?? (network?.external === true ? key : `${project}_${key}`);

/** What `docker compose config --format json` makes of the stack's files, for the parts the panel reads. */
async function resolveConfig(args: readonly string[], project: string): Promise<ComposeFile> {
  const merged: ComposeFile = { services: {}, networks: {} };
  for (const file of await filesOf(args)) {
    Object.assign(merged.networks ?? {}, file.networks ?? {});
    for (const [name, child] of Object.entries(file.services ?? {})) {
      merged.services = { ...merged.services, [name]: { ...merged.services?.[name], ...child } };
    }
  }
  return {
    services: merged.services,
    networks: Object.fromEntries(
      Object.entries(merged.networks ?? {}).map(([key, network]) => [
        key,
        { ...network, name: resolvedName(project, key, network ?? null) },
      ]),
    ),
  };
}

/** The networks the generated override attaches a child to, by the names Docker would report. */
async function overrideNetworks(args: readonly string[], project: string, child: string): Promise<string[]> {
  const resolved = await resolveConfig(args, project);
  const attached = resolved.services?.[child]?.networks;
  const keys = Array.isArray(attached) ? attached.map(String) : Object.keys(attached ?? {});
  return keys.map((key) => resolved.networks?.[key]?.name ?? key);
}

function simulatedContainer(
  project: string,
  child: string,
  image: string,
  labels: Record<string, string>,
  networks: string[],
): ComposeContainerInfo {
  return {
    id: `fake-${project}-${child}-1`,
    name: `${project}-${child}-1`,
    image,
    project,
    child,
    number: 1,
    state: "running",
    status: "Up 2 seconds",
    exitCode: null,
    health: null,
    ports: [],
    labels,
    networks,
  };
}

/**
 * `OPSIFIER_DRIVER=fake` has no Docker CLI to run, so what `docker compose` would do to the
 * containers is applied to the fake driver instead. Tests and the local preview both see real state.
 */
export function installComposeSimulation(deps: AppDeps): void {
  if (!(deps.tools instanceof FakeTools) || !(deps.docker instanceof FakeDriver)) {
    return;
  }
  const { docker } = deps;
  const tools = deps.tools;
  const previous = tools.handler;

  const simulate = async (request: ToolRequest): Promise<ToolResult | undefined> => {
    if (request.command !== "docker" || request.args[0] !== "compose") {
      // A simulated build leaves an image behind, for whoever looks it up afterwards.
      const built = request.args
        .map((arg) => arg.replace(/^--(?:tag|name)=/, ""))
        .find((arg) => arg.startsWith("opsifier/"));
      if (built !== undefined) {
        docker.addLocalImage(built);
      }
      return undefined;
    }
    const { args } = request;
    const project = argument(args, "--project-name") ?? "";
    const verb = args.find((arg) =>
      ["config", "up", "build", "stop", "start", "restart", "down", "logs"].includes(arg),
    );
    const remove = (ids: Set<string>) => {
      for (let index = docker.composeContainers.length - 1; index >= 0; index -= 1) {
        if (ids.has(docker.composeContainers[index]?.id ?? "")) {
          docker.composeContainers.splice(index, 1);
        }
      }
    };
    const own = () => docker.composeContainers.filter((container) => container.project === project);

    switch (verb) {
      case "up": {
        const children = await childrenOf(args);
        const wanted = new Set(children);
        remove(
          new Set(
            own()
              .filter((container) => !wanted.has(container.child))
              .map((container) => container.id),
          ),
        );
        for (const child of children) {
          if (!own().some((container) => container.child === child)) {
            docker.composeContainers.push(
              simulatedContainer(
                project,
                child,
                "fake:latest",
                await overrideLabels(args, child),
                await overrideNetworks(args, project, child),
              ),
            );
          }
          const labels = await overrideLabels(args, child);
          const networks = await overrideNetworks(args, project, child);
          for (const container of own().filter((item) => item.child === child)) {
            container.state = "running";
            container.status = "Up 2 seconds";
            container.exitCode = null;
            container.labels = labels;
            container.networks = networks;
          }
        }
        request.onLine?.(`Simulating docker compose up for ${project}`);
        return ok();
      }
      case "stop":
        for (const container of own()) {
          container.state = "exited";
          container.status = "Exited (0) 1 second ago";
          container.exitCode = 0;
        }
        return ok();
      case "config": {
        const output = argument(args, "--output");
        if (output !== undefined) {
          await writeFile(output, JSON.stringify(await resolveConfig(args, project)));
        }
        return ok();
      }
      case "start":
      case "restart":
        for (const container of own()) {
          container.state = "running";
          container.status = "Up 1 second";
          container.exitCode = null;
        }
        return ok();
      case "down":
        remove(new Set(own().map((container) => container.id)));
        return ok();
      case "logs":
        // A real follow only ends with the stack, so a simulated one ends when it is cancelled.
        if (args.includes("--follow")) {
          request.onLine?.(`web-1  | ${new Date().toISOString()} Simulated output of ${project}`);
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) {
              resolve();
            } else {
              request.signal?.addEventListener("abort", () => resolve(), { once: true });
            }
          });
          return ok();
        }
        return ok();
      default:
        return ok();
    }
  };

  tools.handler = async (request) => (await previous?.(request)) ?? simulate(request);
}
