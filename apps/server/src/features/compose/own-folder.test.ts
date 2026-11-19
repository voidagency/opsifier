import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectComposeFile } from "./inspect";
import { fromStackFolder, heldByRunning, linkedMount, ownFolderIssues, stackRelative } from "./own-folder";
import { inspectResolved } from "./resolved";

const OPTIONS = {
  dataDir: "/var/lib/opsifier",
  project: "shop",
  stack: "shop_stack",
  file: "docker-compose.yml",
};

const mountIssues = (text: string) =>
  inspectComposeFile(text, OPTIONS)
    .issues.filter((issue) => issue.code === "mounts_stack")
    .map((issue) => [issue.service, issue.detail]);

describe("what a stack may mount from its own folder", () => {
  it("reads every spelling of a path from the stack's folder", () => {
    expect(stackRelative(".")).toBe(".");
    expect(stackRelative("./")).toBe(".");
    expect(stackRelative("sub/..")).toBe(".");
    expect(stackRelative("./data/")).toBe("data");
    expect(stackRelative("../x")).toBeNull();
    expect(stackRelative("data", "deploy")).toBe("deploy/data");
  });

  it.each([
    ["the short form", "volumes: ['.:/stack']"],
    ["a trailing slash", "volumes: ['./:/stack']"],
    ["a detour", "volumes: ['./sub/..:/stack']"],
    ["a detour in the long form", "volumes: [{ type: bind, source: 'sub/..', target: /stack }]"],
    ["the long form", "volumes: [{ type: bind, source: ., target: /stack }]"],
  ])("refuses the stack's own folder, written in %s", (_label, line) => {
    expect(mountIssues(`services:\n  web:\n    image: nginx\n    ${line}\n`)).toEqual([["web", "."]]);
  });

  it("refuses a folder that holds what another child, or the same one, mounts", () => {
    expect(
      mountIssues(
        "services:\n  w:\n    image: alpine\n    volumes: ['./data:/data']\n  v:\n    image: alpine\n    volumes: ['./data/inner:/inner', './cache:/c', './cache/x.db:/x.db']\n",
      ),
    ).toEqual([
      ["w", "./data (holds ./data/inner)"],
      ["v", "./cache (holds ./cache/x.db)"],
    ]);
  });

  it("refuses a folder that holds a secret's file, which Compose mounts too", () => {
    expect(
      mountIssues(
        "services:\n  web:\n    image: nginx\n    volumes: ['./keys:/keys']\nsecrets:\n  token:\n    file: ./keys/token\n",
      ),
    ).toEqual([["web", "./keys (holds ./keys/token)"]]);
  });

  it.each([
    [
      "the file the stack starts from",
      "volumes: ['./docker-compose.yml:/c.yml']",
      "",
      "./docker-compose.yml",
    ],
    ["its .env", "volumes: ['./.env:/app/.env']", "", "./.env"],
    [
      "an env file",
      "volumes: ['./conf:/conf']\n    env_file: [{ path: conf/app.env }]",
      "",
      "./conf (holds ./conf/app.env)",
    ],
    [
      "a label file",
      "volumes: ['./meta:/meta']\n    label_file: meta/labels",
      "",
      "./meta (holds ./meta/labels)",
    ],
    [
      "an extended file",
      "volumes: ['./lib:/lib']\n    extends: { file: lib/base.yml, service: base }",
      "",
      "./lib (holds ./lib/base.yml)",
    ],
    [
      "an included file",
      "volumes: ['./inc:/inc']",
      "include:\n  - inc/more.yml\n",
      "./inc (holds ./inc/more.yml)",
    ],
    [
      "the .env an included file reads",
      "volumes: ['./inc:/inc']",
      "include:\n  - path: inc/more.yml\n    project_directory: inc\n",
      "./inc (holds ./inc/.env)",
    ],
  ])("refuses a mount that holds %s", (_label, lines, top, detail) => {
    expect(mountIssues(`${top}services:\n  web:\n    image: nginx\n    ${lines}\n`)).toContainEqual([
      "web",
      detail,
    ]);
  });

  it("counts a name that starts with two dots as inside the stack", () => {
    expect(fromStackFolder("/stack", "/stack/..data")).toBe("..data");
    expect(fromStackFolder("/stack", "/stack/../data")).toBeNull();
    expect(
      mountIssues(
        "services:\n  web:\n    image: nginx\n    env_file: [..vars/app.env]\n    volumes: ['./..data:/data', './..data/sub:/sub', './..vars:/vars']\n",
      ),
    ).toEqual([
      ["web", "./..data (holds ./..data/sub)"],
      ["web", "./..vars (holds ./..vars/app.env)"],
    ]);
  });

  it("refuses a local volume that binds a folder, wherever it leads", () => {
    const volume = (device: string) =>
      `volumes:\n  v:\n    driver: local\n    driver_opts: { type: none, o: bind, device: '${device}' }\n`;
    for (const device of ["./data", ".", "../other", "/srv"]) {
      const { issues } = inspectComposeFile(
        `services:\n  web:\n    image: nginx\n${volume(device)}`,
        OPTIONS,
      );
      expect(issues.map((issue) => [issue.severity, issue.code, issue.detail])).toContainEqual([
        "error",
        "bind_volume",
        "v",
      ]);
    }
  });

  it("lets children share a folder, and mount files and folders beside the stack's own", () => {
    expect(
      mountIssues(
        "services:\n  web:\n    image: nginx\n    env_file: [env/app.env]\n    volumes: ['./shared:/srv', './nginx.conf:/etc/nginx/nginx.conf:ro', './data.d:/d']\n  worker:\n    image: alpine\n    volumes: ['./shared:/data', './data:/x']\n",
      ),
    ).toEqual([]);
  });

  it("reports each mount once, however many times it holds the same thing", () => {
    const issues = ownFolderIssues(
      [
        { service: "a", path: "data" },
        { service: "b", path: "data/x" },
        { service: "c", path: "data/x" },
      ],
      [],
    );
    expect(issues.map((issue) => [issue.service, issue.detail])).toEqual([["a", "./data (holds ./data/x)"]]);
  });
});

describe("what a stack's builds use, against what its children mount", () => {
  const issuesOf = (services: string) =>
    inspectComposeFile(`services:\n${services}`, OPTIONS)
      .issues.filter((issue) => issue.code === "mounts_stack")
      .map((issue) => [issue.service, issue.detail]);

  it.each([
    [
      "a mount that holds a build's context",
      "  web:\n    image: nginx\n    volumes: ['./src:/src']\n  app:\n    build: ./src/app\n",
      ["web", "./src (holds the context ./src/app)"],
    ],
    [
      "a mount that is a build's context",
      "  app:\n    build: ./app\n    volumes: ['./app:/app']\n",
      ["app", "./app (is the context of app)"],
    ],
    [
      "a mount that holds a Dockerfile outside the context",
      "  app:\n    build: { context: ./app, dockerfile: ../docker/Dockerfile }\n  web:\n    image: nginx\n    volumes: ['./docker:/d']\n",
      ["web", "./docker (holds the dockerfile ./docker/Dockerfile)"],
    ],
    [
      "a mount that holds an SSH key a build reads",
      "  app:\n    build: { context: ./app, ssh: ['deploy=./keys/id'] }\n    volumes: ['./keys:/keys']\n",
      ["app", "./keys (holds the ssh ./keys/id)"],
    ],
    [
      "a mount that holds an SSH key a build names in a mapping",
      "  app:\n    build: { context: ./app, ssh: { deploy: ./keys/id } }\n    volumes: ['./keys:/keys']\n",
      ["app", "./keys (holds the ssh ./keys/id)"],
    ],
    [
      "a local cache read from a folder that holds a mount",
      "  app:\n    build: { context: ./app, cache_from: ['type=local,src=./cache'] }\n    volumes: ['./cache/data:/data']\n",
      ["app", "cache_from: ./cache (holds ./cache/data)"],
    ],
    [
      "a local cache written over the stack's own files",
      "  app:\n    build: { context: ./app, cache_to: ['type=local,dest=.'] }\n",
      ["app", "cache_to: . (holds ./docker-compose.yml)"],
    ],
  ])("refuses %s", (_label, services, expected) => {
    expect(issuesOf(services)).toContainEqual(expected);
  });

  it("lets a build use folders no child mounts, the stack's own files among them", () => {
    expect(
      issuesOf(
        "  app:\n    build: { context: ./app, dockerfile: ../docker/Dockerfile, cache_from: ['type=local,src=./cache'] }\n    env_file: [app/app.env]\n    volumes: ['./data:/data']\n  web:\n    build: .\n",
      ),
    ).toEqual([]);
    expect(
      issuesOf(
        "  app:\n    build: { context: ./app, dockerfile: ../docker/Dockerfile }\n    volumes: ['./data:/data']\n",
      ),
    ).toEqual([]);
  });
});

describe("a folder a build only copies", () => {
  const issuesOf = (services: string) =>
    inspectComposeFile(`services:\n${services}`, OPTIONS)
      .issues.filter((issue) => issue.code === "mounts_stack")
      .map((issue) => [issue.service, issue.detail]);

  it.each([
    [
      "the stack's folder beside ./data, the common case",
      "  app:\n    build: .\n    volumes: ['./data:/data']\n",
    ],
    [
      "the stack's folder through a build mapping without a context",
      "  app:\n    build: { dockerfile: docker/Dockerfile }\n    volumes: ['./data:/data']\n",
    ],
    [
      "an added context that holds a mount",
      "  app:\n    build: { context: ./app, additional_contexts: { assets: ./shared } }\n    volumes: ['./shared/uploads:/u']\n",
    ],
  ])("may hold a mount: %s, since a link inside it is copied as a link", (_label, services) => {
    expect(issuesOf(services)).toEqual([]);
  });
});

describe("what Compose resolved a stack to mount", () => {
  const STACK_DIR = "/var/lib/opsifier/projects/shop/stack/code";
  const scope = {
    project: "shop",
    stack: "shop_stack",
    dataDir: "/var/lib/opsifier",
    projectDirectory: STACK_DIR,
    stackFiles: [`${STACK_DIR}/docker-compose.yml`, `${STACK_DIR}/parts/more.yml`, `${STACK_DIR}/.env`],
  };

  it("holds every child's mounts against the others and the files the stack is read from", () => {
    const { issues, mounts } = inspectResolved(
      {
        services: {
          w: { volumes: [{ type: "bind", source: STACK_DIR, target: "/stack" }] },
          v: { volumes: [{ type: "bind", source: `${STACK_DIR}/data`, target: "/data" }] },
          u: {
            volumes: [{ type: "bind", source: `${STACK_DIR}/data/sub`, target: "/sub" }],
            env_file: [{ path: `${STACK_DIR}/conf/u.env` }],
          },
          t: {
            volumes: [
              { type: "bind", source: `${STACK_DIR}/parts`, target: "/parts" },
              { type: "bind", source: `${STACK_DIR}/conf`, target: "/conf" },
            ],
          },
        },
      },
      scope,
    );
    expect(
      issues.filter((issue) => issue.code === "mounts_stack").map((issue) => [issue.service, issue.detail]),
    ).toEqual([
      ["w", "."],
      ["v", "./data (holds ./data/sub)"],
      ["t", "./parts (holds ./parts/more.yml)"],
      ["t", "./conf (holds ./conf/u.env)"],
    ]);
    expect(issues.every((issue) => issue.code !== "mounts_stack" || issue.severity === "error")).toBe(true);
    expect(mounts.map((mount) => mount.path)).toContain(`${STACK_DIR}/data/sub`);
  });

  it("holds a folder whose name starts with two dots to the same rules", () => {
    const { issues, mounts } = inspectResolved(
      {
        services: {
          w: { volumes: [{ type: "bind", source: `${STACK_DIR}/..data`, target: "/d" }] },
          v: { volumes: [{ type: "bind", source: `${STACK_DIR}/..data/sub`, target: "/s" }] },
        },
      },
      scope,
    );
    expect(issues.map((issue) => [issue.code, issue.service, issue.detail])).toEqual([
      ["mounts_stack", "w", "./..data (holds ./..data/sub)"],
    ]);
    expect(mounts.map((mount) => mount.path)).toEqual([`${STACK_DIR}/..data`, `${STACK_DIR}/..data/sub`]);
  });

  it("refuses a bound volume, and holds a source Compose left a $ in to the rules of a mount", () => {
    const { issues, mounts } = inspectResolved(
      {
        services: {
          w: {
            volumes: [
              { type: "volume", source: "v", target: "/v" },
              { type: "bind", source: `${STACK_DIR}/data$$1`, target: "/d" },
            ],
          },
          u: { volumes: [{ type: "bind", source: `${STACK_DIR}/data$1/sub`, target: "/s" }] },
        },
        volumes: {
          v: { name: "shop_stack_v", driver_opts: { type: "none", o: "bind", device: `${STACK_DIR}/vol` } },
          elsewhere: { name: "shop_stack_elsewhere", driver_opts: { o: "bind", device: "/srv/data" } },
          disk: { name: "shop_stack_disk", driver_opts: { type: "ext4", device: "/dev/sdb1" } },
        },
      },
      scope,
    );
    expect(mounts.map((mount) => mount.path)).toEqual(
      expect.arrayContaining([`${STACK_DIR}/data$$1`, `${STACK_DIR}/data$1`]),
    );
    expect(issues.map((issue) => [issue.code, issue.service, issue.detail])).toEqual(
      expect.arrayContaining([
        ["mounts_stack", "w", "./data$1 (holds ./data$1/sub)"],
        ["bind_volume", null, "v"],
        ["bind_volume", null, "elsewhere"],
        ["bind_volume", null, "disk"],
      ]),
    );
    expect(issues.some((issue) => issue.detail?.includes("$$1") && issue.code === "host_path")).toBe(false);
  });

  it("holds what the builds use against the mounts, wherever a variable put them", () => {
    const { issues, inputs } = inspectResolved(
      {
        services: {
          app: {
            build: {
              context: `${STACK_DIR}/src/app`,
              dockerfile: "Dockerfile",
              cache_to: [`type=local,dest=${STACK_DIR}/cache`],
            },
            volumes: [{ type: "bind", source: `${STACK_DIR}/cache/blobs`, target: "/b" }],
          },
          web: { volumes: [{ type: "bind", source: `${STACK_DIR}/src`, target: "/src" }] },
        },
      },
      scope,
    );
    expect(
      issues.filter((issue) => issue.code === "mounts_stack").map((issue) => [issue.service, issue.detail]),
    ).toEqual([
      ["web", "./src (holds the context ./src/app)"],
      ["web", "./src (holds the dockerfile ./src/app/Dockerfile)"],
      ["app", "cache_to: ./cache (holds ./cache/blobs)"],
    ]);
    expect(inputs.map((input) => [input.field, input.path, input.written])).toEqual([
      ["context", `${STACK_DIR}/src/app`, false],
      ["dockerfile", `${STACK_DIR}/src/app/Dockerfile`, false],
      ["cache_to", `${STACK_DIR}/cache`, true],
    ]);
  });
});

describe("what the containers of the last deploy still mount", () => {
  const ROOT = "/var/lib/opsifier/projects/shop/stack/code";
  const bind = (source: string) => ({ child: "w", container: "shop_stack-w-1", source });
  const guarded = {
    mounts: [`${ROOT}/data/sub`, `${ROOT}/shared`],
    files: [`${ROOT}/docker-compose.yml`, `${ROOT}/conf/app.env`, `${ROOT}/.env`],
  };

  it.each([
    ["the stack's own folder", ROOT, ".", "data/sub"],
    ["a folder that holds a new mount", `${ROOT}/data/`, "data", "data/sub"],
    ["a folder that holds a file the stack is read from", `${ROOT}/conf`, "conf", "conf/app.env"],
    ["a file the stack is read from", `${ROOT}/.env`, ".env", ".env"],
  ])("refuses %s", (_label, source, path, holds) => {
    expect(heldByRunning(ROOT, [bind(source)], guarded)).toMatchObject({ path, holds, child: "w" });
  });

  it("lets through what a new mount shares or holds, and what lies outside the stack's folder", () => {
    expect(
      heldByRunning(
        ROOT,
        [bind(`${ROOT}/shared`), bind(`${ROOT}/data/sub/inner`), bind("/srv/confirmed"), bind("/")],
        guarded,
      ),
    ).toBeNull();
  });
});

describe("walking a mount's source before the stack starts", () => {
  let root: string;
  let elsewhere: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "opsifier-own-folder-")));
    elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "opsifier-elsewhere-")));
    mkdirSync(join(root, "real", "deeper"), { recursive: true });
    writeFileSync(join(root, "real", "file.conf"), "x");
    symlinkSync(elsewhere, join(root, "linked"));
    symlinkSync(join(root, "real", "file.conf"), join(root, "real", "file-link.conf"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  const walk = (path: string) => linkedMount(root, [{ service: "web", path: join(root, path) }]);

  it("lets real folders and files through, and what doesn't exist yet", async () => {
    expect(await walk("real/deeper")).toBeNull();
    expect(await walk("real/file.conf")).toBeNull();
    expect(await walk("real/missing/inner")).toBeNull();
  });

  it("stops at a link anywhere on the way, without following it", async () => {
    expect(await walk("linked/inner")).toEqual({
      service: "web",
      path: "linked/inner",
      at: "linked",
      kind: "link",
    });
    expect(await walk("real/file-link.conf")).toMatchObject({ at: "real/file-link.conf", kind: "link" });
  });

  it("walks a name that starts with two dots like any other", async () => {
    symlinkSync(elsewhere, join(root, "..data"));
    expect(await walk("..data/inner")).toMatchObject({ at: "..data", kind: "link" });
  });

  it("stops at a file where a folder should be", async () => {
    expect(await walk("real/file.conf/inner")).toMatchObject({ at: "real/file.conf", kind: "not_a_folder" });
  });
});
