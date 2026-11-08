import { describe, expect, it } from "vitest";
import { DockerDriverError, type TaskInfo, type TaskState } from "./driver";
import { type RolloutTiming, waitForRollout, waitForShutdown } from "./rollout";

const timing: RolloutTiming = { pollMs: 1, stableMs: 0, timeoutMs: 400, maxTaskFailures: 3 };

function task(
  id: string,
  state: TaskState,
  desiredState: TaskState = "running",
  error: string | null = null,
): TaskInfo {
  return {
    id,
    serviceId: "s",
    serviceName: "shop_web",
    slot: 1,
    nodeId: "n",
    containerId: null,
    image: "nginx",
    desiredState,
    state,
    message: state,
    error,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** A driver that answers the given task lists in turn, then repeats the last one. */
function scripted(...frames: Array<TaskInfo[] | Error>) {
  let index = 0;
  return {
    listTasks: async () => {
      const frame = frames[Math.min(index, frames.length - 1)];
      index += 1;
      if (frame instanceof Error) {
        throw frame;
      }
      return frame ?? [];
    },
  };
}

const watch = (
  docker: ReturnType<typeof scripted>,
  previous: string[] = [],
  overrides: Partial<RolloutTiming> = {},
) =>
  waitForRollout({
    docker,
    timing: { ...timing, ...overrides },
    service: "shop_web",
    desired: 1,
    previousTaskIds: new Set(previous),
  });

describe("waitForRollout", () => {
  it("settles once a new task is running", async () => {
    await expect(
      watch(scripted([task("new", "starting")], [task("new", "running")])),
    ).resolves.toBeUndefined();
  });

  it("does not count tasks from before the rollout", async () => {
    await expect(watch(scripted([task("old", "running")]), ["old"], { timeoutMs: 20 })).rejects.toThrow(
      "did not settle",
    );
  });

  it("waits for the task to stay running for the whole stability window", async () => {
    let reads = 0;
    const docker = {
      listTasks: async () => {
        reads += 1;
        return [task("new", "running")];
      },
    };
    await waitForRollout({
      docker,
      timing: { ...timing, stableMs: 20 },
      service: "shop_web",
      desired: 1,
      previousTaskIds: new Set(),
    });
    expect(reads).toBeGreaterThan(1);
  });

  it("restarts the window when a task drops out", async () => {
    const docker = scripted(
      [task("a", "running")],
      [task("a", "failed", "shutdown", "boom"), task("b", "starting")],
      [task("a", "failed", "shutdown", "boom"), task("b", "running")],
    );
    await expect(watch(docker)).resolves.toBeUndefined();
  });

  it("gives up after too many failures, reporting the task's error", async () => {
    const failed = (id: string) => task(id, "failed", "shutdown", "task: non-zero exit (1)");
    const docker = scripted(
      [failed("a")],
      [failed("a"), failed("b")],
      [failed("a"), failed("b"), failed("c")],
    );

    await expect(watch(docker)).rejects.toThrow("non-zero exit");
  });

  it("gives up at once on a clean exit, which Swarm would not retry", async () => {
    const docker = scripted([task("a", "complete", "shutdown")]);
    await expect(watch(docker, [], { timeoutMs: 5000 })).rejects.toThrow("did not stay up");
  });

  it("fails when time runs out", async () => {
    await expect(watch(scripted([task("a", "pending")]), [], { timeoutMs: 10 })).rejects.toThrow(
      "did not settle",
    );
  });

  it("rides out a Docker hiccup", async () => {
    await expect(
      watch(scripted(new DockerDriverError("flaky"), [task("a", "running")])),
    ).resolves.toBeUndefined();
  });

  it("stops at once when cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(
      waitForRollout({
        docker: scripted([]),
        timing,
        service: "shop_web",
        desired: 1,
        previousTaskIds: new Set(),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("logs each task's state once", async () => {
    const lines: string[] = [];
    await waitForRollout({
      docker: scripted([task("abc", "starting")], [task("abc", "starting")], [task("abc", "running")]),
      timing,
      service: "shop_web",
      desired: 1,
      previousTaskIds: new Set(),
      log: (line) => lines.push(line),
    });
    expect(lines.filter((line) => line.includes("starting"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("running"))).toHaveLength(1);
  });
});

describe("waitForShutdown", () => {
  const shut = (docker: ReturnType<typeof scripted>) =>
    waitForShutdown({ docker, timing, service: "shop_web" });

  it("finishes when nothing is live any more", async () => {
    await expect(
      shut(scripted([task("a", "running")], [task("a", "shutdown", "shutdown")])),
    ).resolves.toBeUndefined();
  });

  it("treats a missing service as stopped, the way Docker reports it", async () => {
    await expect(shut(scripted(new DockerDriverError("no such service", 404)))).resolves.toBeUndefined();
  });

  it("fails when time runs out", async () => {
    await expect(
      waitForShutdown({
        docker: scripted([task("a", "running")]),
        timing: { ...timing, timeoutMs: 10 },
        service: "shop_web",
      }),
    ).rejects.toThrow("did not stop");
  });
});
