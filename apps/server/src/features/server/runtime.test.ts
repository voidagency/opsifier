import { systemLogsTopic } from "@opsifier/contract";
import { describe, expect, it } from "vitest";
import { PROXY_CONTAINER } from "../../bootstrap/proxy-container";
import { FakeDriver } from "../../core/docker";
import { createPanelLogsProvider } from "./runtime";

const logger = {
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  info: () => undefined,
};

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("It never happened");
}

describe("the proxy's live logs", () => {
  it("come from its container", async () => {
    const docker = new FakeDriver({ tickMs: 1 });
    await docker.createPlainContainer({
      name: PROXY_CONTAINER,
      image: "traefik:3",
      env: [],
      labels: {},
      binds: [],
      ports: [80, 443],
      networks: ["opsifier"],
      stopTimeoutSeconds: 3,
    });
    await docker.startContainer(PROXY_CONTAINER);
    const container = await docker.inspectPlainContainer(PROXY_CONTAINER);
    docker.writeContainerLog(container?.id ?? "", "Configuration loaded from environment variables");
    const published: unknown[] = [];

    const provider = createPanelLogsProvider({ docker, logger: logger as never });
    expect(provider.matches(systemLogsTopic("proxy"))).toBe(true);
    const feed = provider.open(systemLogsTopic("proxy"), {
      publish: (payload) => published.push(payload),
      pressure: () => 0,
    });

    try {
      await until(() =>
        JSON.stringify(published).includes("Configuration loaded from environment variables"),
      );
    } finally {
      feed.close();
    }
  });
});
