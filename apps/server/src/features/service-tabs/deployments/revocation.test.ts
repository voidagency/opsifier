import { createHash } from "node:crypto";
import type { IssuedDeploymentTrigger, IssuedDeploymentWebhook, PanelUser } from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { services } from "../../../core/db/schema";
import {
  authPost,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
} from "../../../testing/harness";
import { resetPassword } from "../../access/reset-password";
import { findService } from "../../services/repo";
import { upgradeDeploymentAuthority } from "./upgrade";

const TRIGGER = "/projects/shop/services/web/deployments/trigger";

let context: TestContext;
let admin: string;

beforeEach(async () => {
  context = await createTestContext();
  admin = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "shop" }, admin);
  await api("/projects/shop/services", "POST", { name: "web" }, admin);
  await api("/projects/shop/services/web/source", "PUT", { image: "nginx:1.28" }, admin);
});

afterEach(async () => {
  await context.close();
});

function api<T = unknown>(path: string, method: string, body: unknown, cookie: string) {
  return call<T>(context.app, `/api/v1${path}`, { method, body, cookie, origin: TEST_ORIGIN });
}

async function member(
  email: string,
  role: "viewer" | "operator" = "operator",
): Promise<{ user: PanelUser; cookie: string }> {
  const created = await api<PanelUser>(
    "/users",
    "POST",
    { email, password: TEST_PASSWORD, role: "member", projects: [{ project: "shop", role }] },
    admin,
  );
  expect(created.status).toBe(201);
  const login = await authPost(context.app, "login", { email, password: TEST_PASSWORD });
  return { user: created.body, cookie: login.cookie as string };
}

const issueToken = async (cookie: string) =>
  (await api<IssuedDeploymentTrigger>(`${TRIGGER}/rotate`, "POST", undefined, cookie)).body.token;
const deploys = (token: string) =>
  call(context.app, "/api/v1/deploy", { method: "POST", headers: { authorization: `Bearer ${token}` } });

const changeRights = (user: PanelUser, projects: Array<{ project: string; role: string }>) =>
  api(`/users/${user.id}`, "PUT", { email: user.email, role: "member", projects }, admin);

/** A member with a role in every project, and possibly a project of its own on top. */
async function everywhere(
  email: string,
  allProjects: "viewer" | "operator",
  projects: Array<{ project: string; role: "viewer" | "operator" }> = [],
): Promise<{ user: PanelUser; cookie: string }> {
  const created = await api<PanelUser>(
    "/users",
    "POST",
    { email, password: TEST_PASSWORD, role: "member", projects, allProjects },
    admin,
  );
  expect(created.status).toBe(201);
  const login = await authPost(context.app, "login", { email, password: TEST_PASSWORD });
  return { user: created.body, cookie: login.cookie as string };
}

const changeAllProjects = (user: PanelUser, allProjects: "viewer" | "operator" | null) =>
  api(
    `/users/${user.id}`,
    "PUT",
    { email: user.email, role: "member", projects: user.projects, allProjects },
    admin,
  );

describe("when a service moves to another project", () => {
  const move = (projectName: string, name = "web") =>
    api("/projects/shop/services/web/rename", "POST", { projectName, name }, admin);

  it("revokes its deployment token and pauses its webhook, which people of the old project hold", async () => {
    const source = { type: "git", url: "https://git.example.com/acme/shop.git", ref: "main", path: "/" };
    expect((await api("/projects/shop/services/web/source", "PUT", source, admin)).status).toBe(200);
    const { cookie } = await member("op@example.com");
    const token = await issueToken(cookie);
    const webhook = await api<IssuedDeploymentWebhook>(
      "/projects/shop/services/web/deployments/webhook/rotate",
      "POST",
      undefined,
      cookie,
    );
    expect(webhook.status).toBe(200);
    await api("/projects", "POST", { name: "secret" }, admin);

    expect((await move("secret")).status).toBe(200);

    expect((await deploys(token)).status).toBe(401);
    const moved = findService(context.deps.db, "secret", "web");
    expect(moved?.spec.build.deployToken).toBeNull();
    expect(moved?.spec.build.webhook?.paused).toBe(true);
  });

  it("leaves them alone through a rename inside the same project", async () => {
    const { cookie } = await member("op@example.com");
    const token = await issueToken(cookie);

    expect((await move("shop", "renamed")).status).toBe(200);

    expect((await deploys(token)).status).toBe(202);
  });
});

describe("when an account changes", () => {
  it("revokes the tokens it issued once it loses the rights behind them", async () => {
    const { user, cookie } = await member("op@example.com");
    const token = await issueToken(cookie);

    await changeRights(user, [{ project: "shop", role: "viewer" }]);

    expect((await deploys(token)).status).toBe(401);
  });

  it("leaves tokens issued by other accounts alone", async () => {
    const { user } = await member("op@example.com");
    const token = await issueToken(admin);

    await changeRights(user, []);

    expect((await deploys(token)).status).toBe(202);
  });

  it("revokes the tokens it issued as an operator in every project once that role is lowered", async () => {
    const { user, cookie } = await everywhere("all@example.com", "operator");
    const token = await issueToken(cookie);
    expect((await deploys(token)).status).toBe(202);

    await changeAllProjects(user, "viewer");

    expect((await deploys(token)).status).toBe(401);
  });

  it("revokes them when its email or password changes", async () => {
    const one = await member("one@example.com");
    const two = await member("two@example.com");
    const emailed = await issueToken(one.cookie);
    await api(
      `/users/${one.user.id}`,
      "PUT",
      {
        email: "renamed@example.com",
        role: "member",
        projects: [{ project: "shop", role: "operator" }],
      },
      admin,
    );
    expect((await deploys(emailed)).status).toBe(401);

    const passworded = await issueToken(two.cookie);
    await api(
      `/users/${two.user.id}`,
      "PUT",
      {
        email: two.user.email,
        role: "member",
        password: "a brand new password",
        projects: [{ project: "shop", role: "operator" }],
      },
      admin,
    );
    expect((await deploys(passworded)).status).toBe(401);
  });

  it("revokes them when someone changes their own email or password", async () => {
    const { cookie } = await member("self@example.com");
    const token = await issueToken(cookie);

    const changed = await call(context.app, "/api/v1/auth/credentials", {
      method: "POST",
      cookie,
      origin: TEST_ORIGIN,
      body: {
        email: "self2@example.com",
        currentPassword: TEST_PASSWORD,
        newPassword: "a brand new password",
      },
    });

    expect(changed.status).toBe(200);
    expect((await deploys(token)).status).toBe(401);
  });

  it("revokes them when the password is reset from the server's shell", async () => {
    const { user, cookie } = await member("reset@example.com");
    const token = await issueToken(cookie);

    await resetPassword(context.deps.config, user.email);

    expect((await deploys(token)).status).toBe(401);
  });

  it("revokes them when the account is deleted", async () => {
    const { user, cookie } = await member("gone@example.com");
    const token = await issueToken(cookie);

    await api(`/users/${user.id}`, "DELETE", { confirm: user.email }, admin);

    expect((await deploys(token)).status).toBe(401);
  });

  it("pauses a hand-made webhook whose secret it holds, and not one the panel gave GitHub", async () => {
    await api(
      "/projects/shop/services/web/source",
      "PUT",
      {
        type: "git",
        url: "https://git.example.com/acme/shop.git",
        ref: "main",
        path: "/",
      },
      admin,
    );
    const { user, cookie } = await member("op@example.com");
    const issued = (
      await api<IssuedDeploymentWebhook>(
        "/projects/shop/services/web/deployments/webhook/rotate",
        "POST",
        undefined,
        cookie,
      )
    ).body;
    expect(issued.secret).not.toBeNull();

    await changeRights(user, []);

    const row = context.deps.db.select().from(services).where(eq(services.name, "web")).get();
    expect(
      (row?.spec as { build?: { webhook?: { paused?: boolean } } } | undefined)?.build?.webhook?.paused,
    ).toBe(true);
  });

  describe("with a token from before issuers were recorded", () => {
    const OLD = "b".repeat(48);

    beforeEach(() => {
      const row = context.deps.db.select().from(services).where(eq(services.name, "web")).get();
      const spec = row?.spec as { build: Record<string, unknown> };
      spec.build.deployToken = {
        hash: createHash("sha256").update(OLD).digest("hex"),
        sealed: "v1.old.token.x",
      };
      context.deps.db.update(services).set({ spec }).where(eq(services.name, "web")).run();
      upgradeDeploymentAuthority(context.deps);
    });

    const urlDeploys = () => call(context.app, `/api/v1/deploy/${OLD}`, { method: "POST" });

    it("revokes it when someone who could read it stops being able to", async () => {
      const { user } = await member("op@example.com");

      await changeRights(user, [{ project: "shop", role: "viewer" }]);

      expect((await urlDeploys()).status).toBe(404);
    });

    it("revokes it when an operator in every project becomes a viewer in them", async () => {
      const { user } = await everywhere("all@example.com", "operator");

      await changeAllProjects(user, "viewer");

      expect((await urlDeploys()).status).toBe(404);
    });

    it("keeps it when the project's own operator role still covers it", async () => {
      const { user } = await everywhere("all@example.com", "operator", [
        { project: "shop", role: "operator" },
      ]);

      await changeAllProjects(user, null);

      expect((await urlDeploys()).status).toBe(202);
    });

    it("revokes it when an operator in every project is deleted", async () => {
      const { user } = await everywhere("all@example.com", "operator");

      await api(`/users/${user.id}`, "DELETE", { confirm: user.email }, admin);

      expect((await urlDeploys()).status).toBe(404);
    });

    it("leaves it when the account's rights never covered it", async () => {
      await api("/projects", "POST", { name: "other" }, admin);
      const created = await api<PanelUser>(
        "/users",
        "POST",
        {
          email: "far@example.com",
          password: TEST_PASSWORD,
          role: "member",
          projects: [{ project: "other", role: "operator" }],
        },
        admin,
      );

      await changeRights(created.body, []);

      expect((await urlDeploys()).status).toBe(202);
    });

    it("keeps it through a password change, which did not change who could read it", async () => {
      const { user } = await member("op@example.com");

      await api(
        `/users/${user.id}`,
        "PUT",
        {
          email: user.email,
          role: "member",
          password: "a brand new password",
          projects: [{ project: "shop", role: "operator" }],
        },
        admin,
      );

      expect((await urlDeploys()).status).toBe(202);
    });
  });
});
