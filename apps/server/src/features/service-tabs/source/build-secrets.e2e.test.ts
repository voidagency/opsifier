import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Builds a real image and looks at what it kept. Only a real build can show that a secret stays out of
 * the history and the layers: everything else about it can be right and the image still hold it. Run it
 * against a panel in a Docker-in-Docker sandbox, with DOCKER_HOST naming that sandbox's daemon:
 *
 *   OPSIFIER_E2E=1 OPSIFIER_E2E_URL=http://127.0.0.1:3409 DOCKER_HOST=tcp://127.0.0.1:23809 \
 *   OPSIFIER_E2E_EMAIL=... OPSIFIER_E2E_PASSWORD=... \
 *   bunx vitest run apps/server/src/features/service-tabs/source/build-secrets.e2e.test.ts
 */
const enabled = process.env.OPSIFIER_E2E === "1" && process.env.DOCKER_HOST !== undefined;
const BASE = `${process.env.OPSIFIER_E2E_URL ?? "http://127.0.0.1:3409"}/api/v1`;

const SUFFIX = Date.now().toString(36);
const PROJECT = `e2e-secrets-${SUFFIX}`;
const SERVICE = `${BASE}/projects/${PROJECT}/services/app`;
const IMAGE = `opsifier/${PROJECT}/app:latest`;

const BUILD_SECRET = `build-secret-${SUFFIX}-kept-out-of-the-image`;
const RUNTIME_SECRET = `runtime-secret-${SUFFIX}-never-built-with`;
const BUILD_VARIABLE = `build-variable-${SUFFIX}-visible-on-purpose`;
const SLOW = 600_000;

const DOCKERFILE = `FROM busybox:1.36
ARG VISIBLE
ARG RUNTIME_SECRET
RUN echo "declared argument: $VISIBLE"
RUN echo "not given: [$RUNTIME_SECRET]"
RUN --mount=type=secret,id=NPM_TOKEN test -s /run/secrets/NPM_TOKEN && wc -c < /run/secrets/NPM_TOKEN
RUN --mount=type=secret,id=NPM_TOKEN,env=NPM_TOKEN sh -c 'echo "printed by a careless build: $NPM_TOKEN"'
RUN --mount=type=secret,id=env-file,dst=/tmp/.env sh -c 'grep -c NPM_TOKEN= /tmp/.env'
CMD ["sleep", "3600"]
`;

let cookie = "";

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      cookie,
      origin: new URL(BASE).origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie !== null) {
    cookie = setCookie.split(";", 1)[0] ?? "";
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${text}`);
  }
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

const docker = (...args: string[]): string =>
  execFileSync("docker", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** Every file an image's layers hold, as it would be unpacked. */
function everyByteOf(image: string): string {
  const directory = mkdtempSync(join(tmpdir(), "opsifier-e2e-image-"));
  try {
    const archive = join(directory, "image.tar");
    execFileSync("docker", ["save", "-o", archive, image]);
    const unpacked = join(directory, "unpacked");
    execFileSync("mkdir", ["-p", unpacked]);
    execFileSync("tar", ["-xf", archive, "-C", unpacked]);
    const read = (path: string): string => {
      if (statSync(path).isDirectory()) {
        return readdirSync(path)
          .map((name) => read(join(path, name)))
          .join("\n");
      }
      return readFileSync(path).toString("latin1");
    };
    return read(unpacked);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function deployAndWait(): Promise<{ status: string; log: string; error: string | null }> {
  const action = await api<{ id: string }>(`${SERVICE}/deploy`, "POST", {});
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const state = await api<{ status: string; log: string; error: string | null }>(
      `${BASE}/actions/${action.id}`,
    );
    if (state.status !== "queued" && state.status !== "running") {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("The deployment did not finish.");
}

describe.skipIf(!enabled)("a real build", { timeout: SLOW }, () => {
  let log = "";

  beforeAll(async () => {
    await api(`${BASE}/auth/login`, "POST", {
      email: process.env.OPSIFIER_E2E_EMAIL,
      password: process.env.OPSIFIER_E2E_PASSWORD,
    });
    await api(`${BASE}/projects`, "POST", { name: PROJECT });
    await api(`${BASE}/projects/${PROJECT}/services`, "POST", { name: "app" });
    await api(`${SERVICE}/source`, "PUT", { type: "dockerfile", dockerfile: DOCKERFILE });
    await api(`${SERVICE}/environment`, "PUT", { env: `RUNTIME_SECRET=${RUNTIME_SECRET}\n` });
    await api(`${SERVICE}/environment/build`, "PUT", { env: `VISIBLE=${BUILD_VARIABLE}\n` });
    await api(`${SERVICE}/environment/build/secrets/NPM_TOKEN`, "PUT", { value: BUILD_SECRET });
    await api(`${SERVICE}/source/env-file`, "PUT", { path: ".env", inImage: false });
    const deployed = await deployAndWait();
    expect(deployed).toMatchObject({ status: "succeeded", error: null });
    log = deployed.log;
  }, SLOW);

  afterAll(async () => {
    if (enabled) {
      await api(SERVICE, "DELETE", { confirm: "app" }).catch(() => undefined);
    }
  });

  it("leaves the secret out of the image's history and layers", () => {
    const history = docker("history", "--no-trunc", "--format", "{{.CreatedBy}}", IMAGE);
    expect(history).not.toContain(BUILD_SECRET);
    expect(everyByteOf(IMAGE)).not.toContain(BUILD_SECRET);
  });

  it("really did give the step the secret, and the file of variables", () => {
    expect(log).toMatch(new RegExp(`#\\d+ [\\d.]+ ${BUILD_SECRET.length}$`, "m"));
    expect(log).toMatch(/#\d+ [\d.]+ 1$/m);
  });

  it("removes a secret the build printed from the deployment's log", () => {
    expect(log).toContain("printed by a careless build: [redacted]");
    expect(log).not.toContain(BUILD_SECRET);
  });

  it("never gives the build a runtime variable, even one its Dockerfile asks for", () => {
    expect(log).toContain("not given: []");
    expect(log).toContain("This Dockerfile declares RUNTIME_SECRET, which only the container gets");
    expect(everyByteOf(IMAGE)).not.toContain(RUNTIME_SECRET);
  });

  it("gives the container its variables and none of the build's secrets", () => {
    const inspected = docker(
      "service",
      "inspect",
      `${PROJECT}_app`,
      "--format",
      "{{json .Spec.TaskTemplate.ContainerSpec.Env}}",
    );
    expect(inspected).toContain(RUNTIME_SECRET);
    expect(inspected).not.toContain(BUILD_SECRET);
  });

  it("leaves a build variable in the history, as its documentation warns", () => {
    expect(docker("history", "--no-trunc", "--format", "{{.CreatedBy}}", IMAGE)).toContain(BUILD_VARIABLE);
  });
});
