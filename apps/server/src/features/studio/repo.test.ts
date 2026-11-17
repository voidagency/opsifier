import type { CreatedStudioGuestLink, StudioRemarkList } from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { services, studioGuestLinks } from "../../core/db/schema";
import { call, createTestContext, setupAdmin, TEST_ORIGIN, type TestContext } from "../../testing/harness";
import { findApp, moveApp } from "./repo";

let context: TestContext;
let cookie: string;

const api = <T = unknown>(path: string, method = "GET", body?: unknown) =>
  call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });

const serviceId = (name: string) =>
  context.deps.db.select({ id: services.id }).from(services).where(eq(services.name, name)).get()?.id ?? "";

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "lovable" });
  for (const name of ["openhands", "old-preview", "new-preview"]) {
    await api("/projects/lovable/services", "POST", { name });
  }
  await api("/projects/lovable/services/old-preview/domains", "POST", { host: "old.example.com" });
  await api("/settings/studio", "PUT", {
    enabled: true,
    agent: {
      project: "lovable",
      service: "openhands",
      url: "http://127.0.0.1:18000",
      keyFile: null,
      projectsDir: null,
    },
  });
  await api("/projects/lovable/services/old-preview/studio", "PUT", { workspaceDir: "/projects/site" });
});

afterEach(async () => {
  await context.close();
});

describe("a Studio project moving to another preview", () => {
  it("takes its remarks along, and leaves the links that open the old preview behind", async () => {
    const made = await api<CreatedStudioGuestLink>(
      "/projects/lovable/services/old-preview/studio/links",
      "POST",
      {
        label: "Karim Benali · Acme",
      },
    );
    const opened = await call(
      context.app,
      `http://old.example.com/api/proxy-pages/studio/link/${made.body.url.split("/link/")[1]}`,
      { headers: { host: "old.example.com" } },
    );
    await call(context.app, "http://old.example.com/api/proxy-pages/studio/remarks", {
      method: "POST",
      body: { path: "/", text: "Plus de contraste" },
      cookie: opened.cookie,
      origin: "https://old.example.com",
      headers: { host: "old.example.com" },
    });
    const from = serviceId("old-preview");
    const to = serviceId("new-preview");
    const app = findApp(context.deps.db, from);
    expect(app).toBeDefined();

    context.deps.db.transaction((tx) =>
      moveApp(tx, from, { ...(app as NonNullable<typeof app>), serviceId: to }),
    );

    const moved = await api<StudioRemarkList>("/projects/lovable/services/new-preview/studio/remarks");
    expect(moved.body.remarks.map((remark) => [remark.number, remark.text, remark.author])).toEqual([
      [1, "Plus de contraste", "Karim Benali · Acme"],
    ]);
    expect(context.deps.db.select().from(studioGuestLinks).all()).toEqual([]);
  });
});
