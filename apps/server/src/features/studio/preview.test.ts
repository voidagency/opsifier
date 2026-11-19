import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, createTestContext, setupAdmin, TEST_ORIGIN, type TestContext } from "../../testing/harness";
import { findService } from "../services/repo";
import { INSPECTOR_PATH, previewDockerfile, refreshPreviewDockerfiles, SNAPSHOT_PATH } from "./preview";
import { saveApp } from "./repo";

let context: TestContext;
let cookie: string;

const api = (path: string, method = "GET", body?: unknown) =>
  call(context.app, path, { method, body, cookie, origin: TEST_ORIGIN });

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await api("/api/v1/projects", "POST", { name: "studio-site" });
});

afterEach(async () => {
  await context.close();
});

/** A service with this Dockerfile, linked to the Studio when asked. */
async function preview(name: string, dockerfile: string, linked: boolean): Promise<void> {
  const path = `/api/v1/projects/studio-site/services/${name}`;
  await api("/api/v1/projects/studio-site/services", "POST", { name });
  expect((await api(`${path}/source`, "PUT", { type: "dockerfile", dockerfile })).status).toBe(200);
  const id = findService(context.deps.db, "studio-site", name)?.id;
  if (linked && id !== undefined && id !== null) {
    saveApp(context.deps.db, id, "/projects/site", new Date());
  }
}

const dockerfileOf = (name: string) => {
  const source = findService(context.deps.db, "studio-site", name)?.spec.source;
  return source?.type === "dockerfile" ? source.dockerfile : null;
};

describe("the panel's start", () => {
  it("brings the Dockerfile the panel wrote for a linked preview to the current template", async () => {
    const current = previewDockerfile({ uid: 10001, gid: 10001 });
    const earlier = readFileSync(join(import.meta.dirname, "fixtures", "preview-0.11.0.Dockerfile"), "utf8");
    const changed = earlier.replace("WORKDIR /app", "RUN apt-get install -y make\nWORKDIR /app");
    await preview("preview", earlier, true);
    await preview("unlinked", earlier, false);
    await preview("custom", "FROM node:22\nUSER 10001:10001\n", true);
    await preview("changed", changed, true);

    expect(refreshPreviewDockerfiles(context.deps)).toBe(1);

    expect(dockerfileOf("preview")).toBe(current);
    // Not the Studio's, or not one the panel wrote: someone else's to change.
    expect(dockerfileOf("unlinked")).toBe(earlier);
    expect(dockerfileOf("custom")).toBe("FROM node:22\nUSER 10001:10001\n");
    // Changed by hand: someone needed what they added.
    expect(dockerfileOf("changed")).toBe(changed);
    // Nothing left to do the next time.
    expect(refreshPreviewDockerfiles(context.deps)).toBe(0);
  });
});

describe("the inspector", () => {
  it("may be loaded by a preview's page at its own address, unlike the panel's other files", async () => {
    const inspector = await call(context.app, INSPECTOR_PATH);
    const snapshot = await call(context.app, SNAPSHOT_PATH);
    const page = await call(context.app, "/");

    expect(inspector.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(snapshot.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(page.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });
});
