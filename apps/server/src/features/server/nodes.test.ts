import type { SwarmNodeList } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodeInfo, TaskInfo } from "../../core/docker";
import { toNodeInfo } from "../../core/docker/dockerode";
import {
  call,
  createTestContext,
  setupAdmin,
  signInMember,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { listSwarmNodes } from "./nodes";

let context: TestContext;
let cookie: string;

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
});

afterEach(async () => {
  await context.close();
});

const nodes = (as = cookie) =>
  call<SwarmNodeList>(context.app, "/api/v1/server/nodes", { cookie: as, origin: TEST_ORIGIN });

const node = (overrides: Partial<NodeInfo>): NodeInfo => ({
  id: "n1",
  hostname: "node",
  role: "worker",
  leader: false,
  state: "ready",
  availability: "active",
  address: "10.0.0.2",
  engineVersion: "29.1.0",
  os: "linux",
  architecture: "x86_64",
  cpus: 2,
  memoryBytes: 4 * 1024 ** 3,
  ...overrides,
});

describe("the swarm's nodes", () => {
  it("shows the node the panel runs on, and the others the swarm has", async () => {
    context.docker.otherNodes = [
      node({ id: "w1", hostname: "agadir", state: "down", availability: "drain" }),
    ];

    const answer = await nodes();
    expect(answer.status).toBe(200);
    expect(answer.body.nodes).toEqual([
      expect.objectContaining({
        hostname: "fake-node",
        role: "manager",
        leader: true,
        self: true,
        state: "ready",
        address: "203.0.113.10",
      }),
      expect.objectContaining({
        hostname: "agadir",
        role: "worker",
        self: false,
        state: "down",
        availability: "drain",
      }),
    ]);
  });

  it("counts what runs on each node, and puts managers first", async () => {
    const task = (nodeId: string, state: TaskInfo["state"]) => ({ nodeId, state }) as TaskInfo;
    const docker = {
      swarmInfo: async () => ({
        state: "active" as const,
        nodeId: "m2",
        nodeAddr: "10.0.0.3",
        isManager: true,
      }),
      listNodes: async () => [
        node({ id: "w1", hostname: "b-worker" }),
        node({ id: "m2", hostname: "z-manager", role: "manager" }),
        node({ id: "m1", hostname: "a-leader", role: "manager", leader: true }),
      ],
      listTasks: async () => [
        task("w1", "running"),
        task("w1", "running"),
        task("w1", "shutdown"),
        task("m2", "running"),
      ],
    };

    const list = await listSwarmNodes({ docker } as never);
    expect(list.nodes.map((entry) => [entry.hostname, entry.runningTasks, entry.self])).toEqual([
      ["a-leader", 0, false],
      ["z-manager", 1, true],
      ["b-worker", 2, false],
    ]);
  });

  it("is for administrators only", async () => {
    const member = await signInMember(context.app, cookie, "ada@example.com", []);
    expect((await nodes(member)).status).toBe(403);
  });
});

describe("a node as Docker describes it", () => {
  it("reads a manager's address from its manager status, and leaves an unknown state unknown", () => {
    expect(
      toNodeInfo({
        ID: "abc",
        Description: {
          Hostname: "cfc",
          Platform: { Architecture: "x86_64", OS: "linux" },
          Resources: { NanoCPUs: 8_000_000_000, MemoryBytes: 16 * 1024 ** 3 },
          Engine: { EngineVersion: "29.1.0" },
        },
        Spec: { Role: "manager", Availability: "active" },
        Status: { State: "ready", Addr: "0.0.0.0" },
        ManagerStatus: { Leader: true, Addr: "10.0.0.1:2377" },
      }),
    ).toEqual({
      id: "abc",
      hostname: "cfc",
      role: "manager",
      leader: true,
      state: "ready",
      availability: "active",
      address: "10.0.0.1",
      engineVersion: "29.1.0",
      os: "linux",
      architecture: "x86_64",
      cpus: 8,
      memoryBytes: 16 * 1024 ** 3,
    });
    expect(toNodeInfo({ ID: "def123456789xyz", Status: { State: "weird" } })).toMatchObject({
      hostname: "def123456789",
      role: "worker",
      state: "unknown",
      address: null,
      cpus: null,
    });
  });
});
