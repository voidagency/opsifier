import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * What a deployed container really receives, read back from the process itself, because a Swarm spec
 * can look right and still reach the application changed (REQ-479). Against a panel in a sandbox:
 *
 *   OPSIFIER_E2E=1 OPSIFIER_E2E_URL=http://127.0.0.1:3410 OPSIFIER_E2E_DOCKER_HOST=tcp://127.0.0.1:23810 \
 *   OPSIFIER_E2E_EMAIL=... OPSIFIER_E2E_PASSWORD=... \
 *   bunx vitest run apps/server/src/features/service-tabs/environment/environment.e2e.test.ts
 */
const enabled = process.env.OPSIFIER_E2E === "1";
const BASE = `${process.env.OPSIFIER_E2E_URL ?? "http://127.0.0.1:3410"}/api/v1`;
const DOCKER_HOST = process.env.OPSIFIER_E2E_DOCKER_HOST ?? "";
const PROJECT = `e2e-env-${Date.now().toString(36)}`;
const SERVICE = "probe";
const PATH = `/projects/${PROJECT}/services/${SERVICE}`;
const LONG = 300_000;

let cookie = "";

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
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

async function deploy(): Promise<void> {
  const accepted = await api<{ id: string }>(`${PATH}/deploy`, "POST", {});
  for (;;) {
    const action = await api<{ status: string; error: string | null }>(`/actions/${accepted.id}`);
    if (action.status !== "queued" && action.status !== "running") {
      expect(action.error ?? action.status).toBe("succeeded");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function docker(args: readonly string[]): string {
  if (DOCKER_HOST === "") {
    throw new Error("Set OPSIFIER_E2E_DOCKER_HOST to the sandbox's daemon.");
  }
  return execFileSync("docker", ["-H", DOCKER_HOST, ...args], { encoding: "utf8" });
}

/** The environment of the container's own process, one NAME=value per entry, nothing reinterpreted. */
function runningEnv(): Map<string, string> {
  const [container = ""] = docker(["ps", "-q", "--filter", `name=${PROJECT}_${SERVICE}`])
    .trim()
    .split("\n");
  const raw = docker(["exec", container, "cat", "/proc/1/environ"]);
  return new Map(
    raw
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
  );
}

describe.skipIf(!enabled)("variables on a real deployment", () => {
  beforeAll(async () => {
    await api("/auth/login", "POST", {
      email: process.env.OPSIFIER_E2E_EMAIL,
      password: process.env.OPSIFIER_E2E_PASSWORD,
    });
    await api("/projects", "POST", { name: PROJECT });
    await api(`/projects/${PROJECT}/services`, "POST", { name: SERVICE });
    await api(`${PATH}/source`, "PUT", { type: "image", image: "alpine:3.20" });
    await api(`${PATH}/advanced/deploy`, "PUT", { command: "sleep 3600", replicas: 1 });
  }, LONG);

  afterAll(async () => {
    await api(PATH, "DELETE", { confirm: SERVICE }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await api(`/projects/${PROJECT}`, "DELETE", { confirm: PROJECT }).catch(() => undefined);
  }, LONG);

  it(
    "receives spaces, dollars, equals signs and Unicode intact, with several variables at once",
    async () => {
      await api(`${PATH}/environment`, "PUT", {
        env: [
          "WITH_SPACES=hello big world",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text the compiler must leave alone
          "WITH_DOLLAR=price is $5 and ${HOME} and $(NOT_THIS)",
          "WITH_EQUALS=a=b=c==",
          "WITH_UNICODE=héllo wörld 日本語 🎉",
          "ONE=first",
          "TWO=second",
          "NAMED=$(PROJECT_NAME)-$(SERVICE_NAME)",
        ].join("\n"),
      });
      await deploy();

      const env = runningEnv();
      expect(env.get("WITH_SPACES")).toBe("hello big world");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text the compiler must leave alone
      expect(env.get("WITH_DOLLAR")).toBe("price is $5 and ${HOME} and $(NOT_THIS)");
      expect(env.get("WITH_EQUALS")).toBe("a=b=c==");
      expect(env.get("WITH_UNICODE")).toBe("héllo wörld 日本語 🎉");
      expect(env.get("ONE")).toBe("first");
      expect(env.get("TWO")).toBe("second");
      expect(env.get("NAMED")).toBe("$(PROJECT_NAME)-$(SERVICE_NAME)");
    },
    LONG,
  );

  it(
    "fills in the placeholders only once the switch is on",
    async () => {
      await api(`${PATH}/environment`, "PUT", {
        env: "NAMED=$(PROJECT_NAME)-$(SERVICE_NAME)",
        interpolation: true,
      });
      await deploy();
      expect(runningEnv().get("NAMED")).toBe(`${PROJECT}-${SERVICE}`);
    },
    LONG,
  );
});
