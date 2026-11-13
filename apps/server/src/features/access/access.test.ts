import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ActionPage,
  CreatedApiKey,
  DomainsOverview,
  PanelUser,
  ProjectList,
  ServiceDetail,
  SessionState,
  UserList,
} from "@opsifier/contract";
import {
  actionsTopic,
  dockerEventsTopic,
  serviceLogsTopic,
  serviceMetricsTopic,
  servicesMetricsTopic,
} from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actions, apiTokens, users } from "../../core/db/schema";
import {
  apiErrorOf,
  authPost,
  call,
  createTestContext,
  setupAdmin,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
} from "../../testing/harness";
import { insertBackup } from "../backups/repo";
import { BUILT_IN_PROVIDER_ID } from "../storage-providers/service";
import { createTopicGuard } from "./guard";
import { requirementFor } from "./policy";
import { ResetPasswordError, resetPassword } from "./reset-password";

let context: TestContext;
let admin: string;

beforeEach(async () => {
  context = await createTestContext();
  admin = await setupAdmin(context.app);
  for (const project of ["shop", "secret"]) {
    expect((await api("POST", "/api/v1/projects", admin, { name: project })).status).toBe(201);
    expect((await api("POST", `/api/v1/projects/${project}/services`, admin, { name: "web" })).status).toBe(
      201,
    );
  }
});

afterEach(async () => {
  await context.close();
});

function api<T = unknown>(method: string, path: string, cookie: string | undefined, body?: unknown) {
  return call<T>(context.app, path, { method, cookie, body, origin: TEST_ORIGIN });
}

async function createMember(
  email: string,
  projects: Array<{ project: string; role: "viewer" | "operator" }> = [],
  role: "member" | "admin" = "member",
): Promise<{ user: PanelUser; cookie: string }> {
  const created = await api<PanelUser>("POST", "/api/v1/users", admin, {
    email,
    password: TEST_PASSWORD,
    role,
    projects,
  });
  expect(created.status).toBe(201);
  const login = await authPost(context.app, "login", { email, password: TEST_PASSWORD });
  expect(login.status).toBe(200);
  return { user: created.body, cookie: login.cookie as string };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function withKey<T = unknown>(method: string, path: string, token: string, body?: unknown) {
  return call<T>(context.app, path, { method, headers: bearer(token), body });
}

describe("accounts", () => {
  it("creates, updates and deletes accounts, and keeps the owner", async () => {
    const list = await api<{ users: PanelUser[] }>("GET", "/api/v1/users", admin);
    expect(list.status).toBe(200);
    expect(list.body.users).toHaveLength(1);
    expect(list.body.users[0]).toMatchObject({ owner: true, role: "admin" });

    const { user } = await createMember("Sam@Example.com", [{ project: "shop", role: "viewer" }]);
    expect(user.email).toBe("sam@example.com");

    const ownerId = list.body.users[0]?.id;
    const demote = await api("PUT", `/api/v1/users/${ownerId}`, admin, {
      email: "admin@example.com",
      role: "member",
      projects: [],
    });
    expect(demote.status).toBe(409);
    expect(apiErrorOf(demote).code).toBe("owner_protected");

    const removeOwner = await api("DELETE", `/api/v1/users/${ownerId}`, admin, {
      confirm: "admin@example.com",
    });
    expect(removeOwner.status).toBe(409);

    const wrong = await api("DELETE", `/api/v1/users/${user.id}`, admin, { confirm: "someone@example.com" });
    expect(wrong.status).toBe(409);
    expect(apiErrorOf(wrong).code).toBe("confirmation_mismatch");

    expect((await api("DELETE", `/api/v1/users/${user.id}`, admin, { confirm: user.email })).status).toBe(
      200,
    );
  });

  it("rejects bad input and duplicate emails", async () => {
    const missing = await api("POST", "/api/v1/users", admin, { email: "nope", password: "short" });
    expect(missing.status).toBe(400);
    expect(Object.keys(apiErrorOf(missing).fields ?? {})).toEqual(
      expect.arrayContaining(["email", "password"]),
    );

    await createMember("dup@example.com");
    const duplicate = await api("POST", "/api/v1/users", admin, {
      email: "dup@example.com",
      password: TEST_PASSWORD,
    });
    expect(duplicate.status).toBe(409);
    expect(apiErrorOf(duplicate).code).toBe("email_taken");
  });

  it("is closed to members", async () => {
    const { cookie } = await createMember("m@example.com");
    expect((await api("GET", "/api/v1/users", cookie)).status).toBe(403);
    expect((await api("GET", "/api/v1/monitor/system", cookie)).status).toBe(403);
    expect((await api("POST", "/api/v1/projects", cookie, { name: "mine" })).status).toBe(403);
    expect((await api("GET", "/api/v1/server/overview", cookie)).status).toBe(403);
  });
});

describe("administering the server itself", () => {
  const ownerId = async () =>
    (await api<UserList>("GET", "/api/v1/users", admin)).body.users.find((user) => user.owner)?.id as string;
  const setHostAdmin = (as: string, user: PanelUser, hostAdmin: boolean) =>
    api<PanelUser>("PUT", `/api/v1/users/${user.id}`, as, {
      email: user.email,
      role: user.role,
      projects: [],
      hostAdmin,
    });

  it("is apart from being an administrator: only the owner holds it to begin with", async () => {
    const { user, cookie } = await createMember("sysadmin@example.com", [], "admin");
    expect(user.hostAdmin).toBe(false);

    expect((await api("POST", "/api/v1/server/reboot", cookie, { confirm: "reboot" })).status).toBe(403);
    const refused = await api("GET", "/api/v1/server/disk", cookie);
    expect(refused.status).toBe(403);
    expect(apiErrorOf(refused).code).toBe("host_admin_required");

    expect((await api("GET", "/api/v1/server/disk", admin)).status).not.toBe(403);
    const session = await api<SessionState>("GET", "/api/v1/auth/session", cookie);
    expect(session.body).toMatchObject({ status: "signed-in", user: { hostAdmin: false } });
    const owner = await api<SessionState>("GET", "/api/v1/auth/session", admin);
    expect(owner.body).toMatchObject({ status: "signed-in", user: { hostAdmin: true } });
  });

  it("is given and taken away by the owner alone", async () => {
    const { user, cookie } = await createMember("sysadmin@example.com", [], "admin");
    const other = await createMember("other@example.com", [], "admin");

    const refused = await setHostAdmin(other.cookie, user, true);
    expect(refused.status).toBe(403);
    expect(apiErrorOf(refused).code).toBe("owner_required");

    const granted = await setHostAdmin(admin, user, true);
    expect(granted.status).toBe(200);
    expect(granted.body.hostAdmin).toBe(true);
    expect((await api("GET", "/api/v1/server/disk", cookie)).status).not.toBe(403);

    const revoked = await setHostAdmin(admin, user, false);
    expect(revoked.body.hostAdmin).toBe(false);
    // Taking a right away ends the sessions that held it, so an open console goes too.
    expect((await api("GET", "/api/v1/server/disk", cookie)).status).toBe(401);
  });

  it("can't be held by a member, and an administrator edit that leaves it out doesn't change it", async () => {
    const { user, cookie } = await createMember("sysadmin@example.com", [], "admin");
    await setHostAdmin(admin, user, true);

    const kept = await api<PanelUser>("PUT", `/api/v1/users/${user.id}`, admin, {
      email: user.email,
      role: "admin",
      projects: [],
    });
    expect(kept.body.hostAdmin).toBe(true);
    expect((await api("GET", "/api/v1/server/disk", cookie)).status).not.toBe(403);

    const demoted = await api<PanelUser>("PUT", `/api/v1/users/${user.id}`, admin, {
      email: user.email,
      role: "member",
      projects: [],
      hostAdmin: true,
    });
    expect(demoted.body.hostAdmin).toBe(false);
  });

  it("can't be taken from the owner", async () => {
    const ownerUser = (await api<UserList>("GET", "/api/v1/users", admin)).body.users.find(
      (user) => user.owner,
    ) as PanelUser;
    expect(ownerUser.hostAdmin).toBe(true);

    const result = await setHostAdmin(admin, ownerUser, false);

    expect(result.body.hostAdmin).toBe(true);
    expect(await ownerId()).toBe(ownerUser.id);
  });

  describe("an account that holds it", () => {
    const owner = async () =>
      (await api<UserList>("GET", "/api/v1/users", admin)).body.users.find((user) => user.owner) as PanelUser;
    const edit = (as: string, user: PanelUser, change: Record<string, unknown>) =>
      api<PanelUser>("PUT", `/api/v1/users/${user.id}`, as, {
        email: user.email,
        role: user.role,
        projects: [],
        ...change,
      });

    it.each([
      ["password", { password: "a-password-someone-else-picked" }],
      ["email", { email: "taken-over@example.com" }],
    ])("keeps its %s the owner's to change, since it opens the server", async (_field, change) => {
      const { user: sysadmin, cookie: sysadminSession } = await createMember(
        "sysadmin@example.com",
        [],
        "admin",
      );
      await setHostAdmin(admin, sysadmin, true);
      const other = await createMember("other@example.com", [], "admin");

      for (const target of [{ ...sysadmin, hostAdmin: true }, await owner()]) {
        const refused = await edit(other.cookie, target, change);
        expect(refused.status).toBe(403);
        expect(apiErrorOf(refused).code).toBe("owner_required");
      }
      // Nothing changed: the holder is still signed in, and the password someone picked opens nothing.
      expect((await api("GET", "/api/v1/server/disk", sysadminSession)).status).not.toBe(401);
      const login = await authPost(context.app, "login", {
        email: "sysadmin@example.com",
        password: "a-password-someone-else-picked",
      });
      expect(login.status).toBe(401);

      expect((await edit(admin, { ...sysadmin, hostAdmin: true }, change)).status).toBe(200);
    });

    it("can't lose it to another administrator's demotion, nor its account", async () => {
      const { user: sysadmin } = await createMember("sysadmin@example.com", [], "admin");
      await setHostAdmin(admin, sysadmin, true);
      const other = await createMember("other@example.com", [], "admin");

      const demoted = await edit(other.cookie, sysadmin, { role: "member" });
      expect(demoted.status).toBe(403);
      expect(apiErrorOf(demoted).code).toBe("owner_required");
      const deactivated = await api("POST", `/api/v1/users/${sysadmin.id}/active`, other.cookie, {
        active: false,
      });
      expect(deactivated.status).toBe(403);
      const deleted = await api("DELETE", `/api/v1/users/${sysadmin.id}`, other.cookie, {
        confirm: sysadmin.email,
      });
      expect(deleted.status).toBe(403);
    });

    it("leaves ordinary administrators to each other", async () => {
      const { user } = await createMember("plain@example.com", [], "admin");
      const other = await createMember("other@example.com", [], "admin");

      expect((await edit(other.cookie, user, { password: "a-new-password-for-plain" })).status).toBe(200);
      expect((await edit(other.cookie, user, { role: "member" })).status).toBe(200);
    });
  });

  it("gives an API key no way in, however its owner stands", async () => {
    const key = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", admin, { name: "automation" });
    const refused = await withKey("GET", "/api/v1/server/disk", key.body.token);

    expect(refused.status).toBe(403);
    expect(apiErrorOf(refused).code).toBe("host_admin_required");
  });
});

describe("deactivating an account", () => {
  const setActive = (id: string, active: boolean, cookie = admin) =>
    api<PanelUser>("POST", `/api/v1/users/${id}/active`, cookie, { active });
  const signIn = (email: string) => authPost(context.app, "login", { email, password: TEST_PASSWORD });

  it("ends its sessions and keys at once, and keeps it from signing in", async () => {
    const { user, cookie } = await createMember("o@example.com", [{ project: "shop", role: "operator" }]);
    const key = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", cookie, {
      name: "ci",
      level: "write",
    });
    expect((await api("GET", "/api/v1/projects/shop", cookie)).status).toBe(200);

    const done = await setActive(user.id, false);

    expect(done.status).toBe(200);
    expect(done.body.active).toBe(false);
    expect((await api("GET", "/api/v1/projects/shop", cookie)).status).toBe(401);
    expect((await withKey("GET", "/api/v1/projects/shop", key.body.token)).status).toBe(401);

    const refused = await signIn(user.email);
    expect(refused.status).toBe(401);
    expect(apiErrorOf(refused).code).toBe("invalid_credentials");
    // A wrong password on the same account answers the same way, so this reveals nothing.
    const wrong = await authPost(context.app, "login", {
      email: user.email,
      password: "not the password at all",
    });
    expect(wrong.body).toEqual(refused.body);
  });

  it("keeps what the account could reach for when it comes back", async () => {
    const { user } = await createMember("o@example.com", [{ project: "shop", role: "operator" }]);
    await setActive(user.id, false);

    expect((await setActive(user.id, true)).body.active).toBe(true);

    const login = await signIn(user.email);
    expect(login.status).toBe(200);
    expect((await api("GET", "/api/v1/projects/shop", login.cookie)).status).toBe(200);
  });

  it("does not bring back a key or a session it ended", async () => {
    const { user, cookie } = await createMember("o@example.com", [{ project: "shop", role: "operator" }]);
    const key = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", cookie, { name: "ci" });

    await setActive(user.id, false);
    await setActive(user.id, true);

    expect((await withKey("GET", "/api/v1/projects", key.body.token)).status).toBe(401);
    expect((await api("GET", "/api/v1/projects", cookie)).status).toBe(401);
  });

  it("refuses a session or key that outlived the deactivation", async () => {
    const { user, cookie } = await createMember("o@example.com", [{ project: "shop", role: "operator" }]);
    const key = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", cookie, { name: "ci" });
    // As a login racing the deactivation would leave behind.
    context.deps.db.update(users).set({ deactivatedAt: new Date() }).where(eq(users.id, user.id)).run();

    expect((await api("GET", "/api/v1/projects", cookie)).status).toBe(401);
    expect((await withKey("GET", "/api/v1/projects", key.body.token)).status).toBe(401);
  });

  it("protects the owner and the person doing it", async () => {
    const list = await api<{ users: PanelUser[] }>("GET", "/api/v1/users", admin);
    const owner = list.body.users[0] as PanelUser;
    const refused = await setActive(owner.id, false);
    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("owner_protected");

    const other = await createMember("a2@example.com", [], "admin");
    const self = await setActive(other.user.id, false, other.cookie);
    expect(self.status).toBe(409);
    expect(apiErrorOf(self).code).toBe("change_own_account");
  });

  it("is an administrator's to do, and shows in the list", async () => {
    const { user, cookie } = await createMember("o@example.com", [{ project: "shop", role: "operator" }]);
    const target = await createMember("t@example.com", []);

    expect((await setActive(target.user.id, false, cookie)).status).toBe(403);
    expect((await setActive("no-such-id", false)).status).toBe(404);

    await setActive(target.user.id, false);
    const list = await api<{ users: PanelUser[] }>("GET", "/api/v1/users", admin);
    expect(list.body.users.find((item) => item.id === target.user.id)?.active).toBe(false);
    expect(list.body.users.find((item) => item.id === user.id)?.active).toBe(true);
  });
});

describe("per-project access", () => {
  it("makes another project look exactly like one that does not exist", async () => {
    const { cookie } = await createMember("m@example.com", [{ project: "shop", role: "operator" }]);

    for (const [method, path] of [
      ["GET", "/api/v1/projects/secret"],
      ["GET", "/api/v1/projects/secret/services/web"],
      ["GET", "/api/v1/projects/secret/services/web/environment"],
      ["POST", "/api/v1/projects/secret/services/web/deploy"],
      ["GET", "/api/v1/projects/secret/services/web/logs/search"],
      ["GET", "/api/v1/projects/secret/services/web/domains"],
    ] as const) {
      const inaccessible = await api(method, path, cookie, method === "POST" ? {} : undefined);
      const missing = await api(
        method,
        path.replace("/secret", "/does-not-exist"),
        cookie,
        method === "POST" ? {} : undefined,
      );
      expect(inaccessible.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(inaccessible.body).toEqual(missing.body);
    }

    const encoded = await api("GET", "/api/v1/projects/s%65cret/services/web", cookie);
    expect(encoded.status).toBe(404);
  });

  it("lists only what the member can reach", async () => {
    const { cookie } = await createMember("m@example.com", [{ project: "shop", role: "viewer" }]);
    await api("POST", "/api/v1/projects/secret/services/web/deploy", admin, {});

    const projects = await api<ProjectList>("GET", "/api/v1/projects", cookie);
    expect(projects.body.projects.map((project) => project.name)).toEqual(["shop"]);

    const actions = await api<ActionPage>("GET", "/api/v1/actions", cookie);
    expect(actions.status).toBe(200);
    expect(actions.body.items.every((item) => item.projectName !== "secret")).toBe(true);

    const domains = await api<DomainsOverview>("GET", "/api/v1/domains", cookie);
    expect(
      domains.body.domains.map((domain) => (domain.destination === "service" ? domain.projectName : "")),
    ).toEqual(["shop"]);
  });

  it("hides an action of another project behind a 404", async () => {
    const { cookie } = await createMember("m@example.com", [{ project: "shop", role: "operator" }]);
    const list = await api<ActionPage>("GET", "/api/v1/actions?limit=100", admin);
    const entry = list.body.items.find((item) => item.projectName === "secret");
    expect(entry).toBeDefined();
    const detail = await api("GET", `/api/v1/actions/${entry?.id}`, cookie);
    expect(detail.status).toBe(404);
    const missing = await api("GET", "/api/v1/actions/does-not-exist", cookie);
    expect(detail.body).toEqual(missing.body);
    expect((await api("POST", `/api/v1/actions/${entry?.id}/cancel`, cookie)).status).toBe(404);
  });

  it("gives a viewer the inventory and refuses everything else with 403", async () => {
    const { cookie } = await createMember("v@example.com", [{ project: "shop", role: "viewer" }]);
    await api("PUT", "/api/v1/projects/shop/services/web/notes", admin, { notes: "private note" });

    const detail = await api<ServiceDetail>("GET", "/api/v1/projects/shop/services/web", cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.notes).toBe("");

    expect((await api("GET", "/api/v1/projects/shop/services/web/environment", cookie)).status).toBe(403);
    expect((await api("GET", "/api/v1/projects/shop/services/web/logs/search", cookie)).status).toBe(403);
    expect((await api("POST", "/api/v1/projects/shop/services/web/deploy", cookie, {})).status).toBe(403);
  });

  describe("a backup download", () => {
    const contents = Buffer.from("not really a dump, but exactly these bytes\n");

    /** A finished backup of `project`/web, as a run would have left it in Local Disk. */
    function storedBackup(
      project: string,
      createdAt = new Date(context.deps.now()),
    ): { id: string; path: string } {
      const id = `backup-of-${project}`;
      const path = `${project}/web/2026-01-01T00:00:00.000Z.tar.gz`;
      const file = join(context.dataDir, "backups", path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents);
      insertBackup(context.deps.db, {
        id,
        projectName: project,
        serviceName: "web",
        kind: "volume",
        origin: "manual",
        status: "succeeded",
        volumeName: "data",
        format: "volume-tar-gz-v1",
        scope: "volume",
        storageProviderId: BUILT_IN_PROVIDER_ID,
        storageProviderName: "Local Disk",
        path,
        sizeBytes: contents.length,
        sha256: createHash("sha256").update(contents).digest("hex"),
        createdAt,
      });
      return { id, path };
    }

    describe("left by an earlier project of the same name", () => {
      // Older than the project and service that have these names now: what a destroyed one left.
      const EARLIER = new Date(Date.UTC(2020, 0, 1));
      async function waitForAction(id: string): Promise<{ status: string; error: string | null }> {
        for (let attempt = 0; attempt < 1000; attempt += 1) {
          const { body } = await api<{ status: string; error: string | null }>(
            "GET",
            `/api/v1/actions/${id}`,
            admin,
          );
          if (body.status !== "queued" && body.status !== "running") {
            return body;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error("The action did not finish");
      }
      const restoreBody = (path: string) => ({
        storageProviderId: BUILT_IN_PROVIDER_ID,
        path,
        databaseName: "data",
        confirm: "data",
      });

      it("is not that project's, for its people, by id or by path", async () => {
        const { id, path } = storedBackup("secret", EARLIER);
        const { cookie } = await createMember("o@example.com", [{ project: "secret", role: "operator" }]);

        expect((await api("GET", urlOf("secret", id), cookie)).status).toBe(404);
        expect(
          (
            await api("POST", `/api/v1/projects/secret/services/web/backups/${id}/restore`, cookie, {
              confirm: "web",
            })
          ).status,
        ).toBe(404);
        expect(
          (await api("DELETE", `/api/v1/projects/secret/services/web/backups/${id}`, cookie)).status,
        ).toBe(404);

        expect(
          (
            await api("POST", "/api/v1/projects/secret/services/web/storage/mounts", admin, {
              type: "volume",
              name: "data",
              mountPath: "/data",
            })
          ).status,
        ).toBe(201);
        await api("PUT", "/api/v1/projects/secret/services/web/source", admin, { image: "nginx:1.28" });
        const deployed = await api<{ id: string }>(
          "POST",
          "/api/v1/projects/secret/services/web/deploy",
          admin,
          {},
        );
        expect((await waitForAction(deployed.body.id)).status).toBe("succeeded");
        const byPath = await api<{ id: string }>(
          "POST",
          "/api/v1/projects/secret/services/web/backups/restore",
          cookie,
          restoreBody(path),
        );
        expect(byPath.status).toBe(202);
        const finished = await waitForAction(byPath.body.id);
        expect(finished.status).toBe("failed");
        // Someone else's file answers exactly as an absent one does.
        expect(finished.error).toMatch(/no longer exists/);
      });

      it("keeps its history to itself", async () => {
        context.deps.db
          .insert(actions)
          .values({
            id: "earlier-secret-backup",
            type: "backup.run",
            title: "Back up secret/web",
            status: "succeeded",
            hasLog: false,
            projectName: "secret",
            serviceName: "web",
            createdAt: EARLIER,
          })
          .run();
        const { cookie } = await createMember("o@example.com", [{ project: "secret", role: "operator" }]);

        const listed = await api<ActionPage>("GET", "/api/v1/actions?limit=100", cookie);
        expect(listed.body.items.some((item) => item.id === "earlier-secret-backup")).toBe(false);
        expect((await api("GET", "/api/v1/actions/earlier-secret-backup", cookie)).status).toBe(404);
        const all = await api<ActionPage>("GET", "/api/v1/actions?limit=100", admin);
        expect(all.body.items.some((item) => item.id === "earlier-secret-backup")).toBe(true);
      });
    });

    const urlOf = (project: string, id: string) =>
      `/api/v1/projects/${project}/services/web/backups/${id}/download`;

    const request = (url: string, headers: Record<string, string>) =>
      context.app.request(url, { method: "GET", headers });

    it("answers out of reach exactly as for a backup that does not exist", async () => {
      const { id } = storedBackup("secret");
      const { cookie } = await createMember("o@example.com", [{ project: "shop", role: "operator" }]);

      const outOfReach = await api("GET", urlOf("secret", id), cookie);
      const missingProject = await api("GET", urlOf("no-such-project", id), cookie);
      expect(outOfReach.status).toBe(404);
      expect(missingProject.status).toBe(404);
      expect(outOfReach.body).toEqual(missingProject.body);
    });

    it("does not let a project's address reach another project's backup", async () => {
      const { id } = storedBackup("secret");
      const { cookie } = await createMember("o@example.com", [{ project: "shop", role: "operator" }]);

      expect((await api("GET", urlOf("shop", id), cookie)).status).toBe(404);
    });

    it("is refused to a viewer of the project with 403", async () => {
      const { id } = storedBackup("shop");
      const { cookie } = await createMember("v@example.com", [{ project: "shop", role: "viewer" }]);

      const refused = await api("GET", urlOf("shop", id), cookie);
      expect(refused.status).toBe(403);
    });

    it("needs a signature", async () => {
      const { id } = storedBackup("shop");
      expect((await request(urlOf("shop", id), {})).status).toBe(401);
    });

    it("gives an operator the file, and holds a key to the projects it names", async () => {
      const { id } = storedBackup("shop");
      const owner = await createMember("o@example.com", [
        { project: "shop", role: "operator" },
        { project: "secret", role: "operator" },
      ]);

      const allowed = await request(urlOf("shop", id), { cookie: owner.cookie });
      expect(allowed.status).toBe(200);
      expect(Buffer.from(await allowed.arrayBuffer()).equals(contents)).toBe(true);

      const key = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", owner.cookie, {
        name: "backup job",
        level: "read",
        projects: ["shop"],
      });
      const byKey = await request(urlOf("shop", id), bearer(key.body.token));
      expect(byKey.status).toBe(200);
      expect(Buffer.from(await byKey.arrayBuffer()).equals(contents)).toBe(true);

      const secret = storedBackup("secret");
      const outside = await withKey("GET", urlOf("secret", secret.id), key.body.token);
      expect(outside.status).toBe(404);
    });
  });

  it("lets an operator work in their project but not delete it", async () => {
    const { cookie } = await createMember("o@example.com", [{ project: "shop", role: "operator" }]);
    expect((await api("GET", "/api/v1/projects/shop/services/web/environment", cookie)).status).toBe(200);
    const destroy = await api("DELETE", "/api/v1/projects/shop", cookie, { confirm: "shop" });
    expect(destroy.status).toBe(403);
  });

  it("takes rights away at once, and ends the sessions and keys that held them", async () => {
    const { user, cookie } = await createMember("o@example.com", [
      { project: "shop", role: "operator" },
      { project: "secret", role: "operator" },
    ]);
    const key = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", cookie, {
      name: "ci",
      level: "write",
    });
    expect((await withKey("GET", "/api/v1/projects/secret", key.body.token)).status).toBe(200);

    const lowered = await api("PUT", `/api/v1/users/${user.id}`, admin, {
      email: user.email,
      role: "member",
      projects: [{ project: "shop", role: "operator" }],
    });
    expect(lowered.status).toBe(200);

    expect((await api("GET", "/api/v1/projects/secret", cookie)).status).toBe(401);
    expect((await withKey("GET", "/api/v1/projects/secret", key.body.token)).status).toBe(401);
  });

  it("keeps sessions when a member only gains a project", async () => {
    const { user, cookie } = await createMember("g@example.com", [{ project: "shop", role: "viewer" }]);
    await api("PUT", `/api/v1/users/${user.id}`, admin, {
      email: user.email,
      role: "member",
      projects: [
        { project: "shop", role: "viewer" },
        { project: "secret", role: "viewer" },
      ],
    });
    expect((await api("GET", "/api/v1/projects/secret", cookie)).status).toBe(200);
  });
});

describe("moving a service between projects", () => {
  const moveWeb = (cookie: string | undefined, projectName: string, name = "web") =>
    api("POST", "/api/v1/projects/shop/services/web/rename", cookie, { projectName, name });

  it("answers for a project out of reach exactly as for one that does not exist", async () => {
    const { cookie } = await createMember("o@example.com", [{ project: "shop", role: "operator" }]);

    const outOfReach = await moveWeb(cookie, "secret", "taken-away");
    const missing = await moveWeb(cookie, "no-such-project", "taken-away");

    expect(outOfReach.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(outOfReach.body).toEqual(missing.body);
    expect((await api("GET", "/api/v1/projects/shop/services/web", admin)).status).toBe(200);
    expect((await api("GET", "/api/v1/projects/secret/services/taken-away", admin)).status).toBe(404);
  });

  it("refuses a project the caller can only look at", async () => {
    const { cookie } = await createMember("o@example.com", [
      { project: "shop", role: "operator" },
      { project: "secret", role: "viewer" },
    ]);

    const refused = await moveWeb(cookie, "secret", "taken-away");

    expect(refused.status).toBe(403);
    expect((await api("GET", "/api/v1/projects/shop/services/web", admin)).status).toBe(200);
  });

  it("needs the operator role on both ends, and hands the service over with its history", async () => {
    const both = await createMember("both@example.com", [
      { project: "shop", role: "operator" },
      { project: "secret", role: "operator" },
    ]);
    const onlyShop = await createMember("shop@example.com", [{ project: "shop", role: "operator" }]);
    const onlySecret = await createMember("secret@example.com", [{ project: "secret", role: "operator" }]);

    const moved = await moveWeb(both.cookie, "secret", "moved");
    expect(moved.status).toBe(200);

    const path = "/api/v1/projects/secret/services/moved";
    expect((await api("GET", path, onlySecret.cookie)).status).toBe(200);
    expect((await api("GET", path, onlyShop.cookie)).status).toBe(404);

    const history = await api<ActionPage>("GET", "/api/v1/actions?limit=100", onlyShop.cookie);
    expect(history.body.items.filter((item) => item.serviceName === "moved")).toEqual([]);
    const newHome = await api<ActionPage>("GET", "/api/v1/actions?limit=100", onlySecret.cookie);
    expect(newHome.body.items.some((item) => item.title === "Rename shop/web")).toBe(true);
  });

  it("still lets an operator rename a service inside their project", async () => {
    const { cookie } = await createMember("o@example.com", [{ project: "shop", role: "operator" }]);

    expect((await moveWeb(cookie, "shop", "renamed")).status).toBe(200);
  });

  it("holds a project-scoped key to the projects it names, even when its owner reaches more", async () => {
    const owner = await createMember("o@example.com", [
      { project: "shop", role: "operator" },
      { project: "secret", role: "operator" },
    ]);
    const key = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", owner.cookie, {
      name: "ci",
      level: "write",
      projects: ["shop"],
    });
    const rename = (projectName: string, name: string) =>
      withKey("POST", "/api/v1/projects/shop/services/web/rename", key.body.token, { projectName, name });

    const across = await rename("secret", "taken-away");
    const missing = await rename("no-such-project", "taken-away");
    expect(across.status).toBe(404);
    expect(across.body).toEqual(missing.body);

    expect((await rename("shop", "renamed")).status).toBe(200);
  });

  it("confines an administrator's scoped key too", async () => {
    const key = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", admin, {
      name: "scoped",
      level: "write",
      projects: ["shop"],
    });

    const across = await withKey("POST", "/api/v1/projects/shop/services/web/rename", key.body.token, {
      projectName: "secret",
      name: "web",
    });
    expect(across.status).toBe(404);
  });
});

describe("API keys", () => {
  it("shows the secret once and stores only its hash", async () => {
    const created = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", admin, { name: "ci" });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^opsifier_/);

    const stored = context.deps.db.select().from(apiTokens).where(eq(apiTokens.id, created.body.id)).get();
    expect(stored?.tokenHash).not.toContain(created.body.token);
    expect(JSON.stringify(stored)).not.toContain(created.body.token);

    const list = await api<{ keys: unknown[] }>("GET", "/api/v1/me/api-keys", admin);
    expect(JSON.stringify(list.body)).not.toContain(created.body.token);
  });

  it("has a default expiry, a maximum, and stops working once expired or revoked", async () => {
    const created = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", admin, {
      name: "ci",
      expiresInDays: 1,
    });
    const tooLong = await api("POST", "/api/v1/me/api-keys", admin, { name: "x", expiresInDays: 1000 });
    expect(tooLong.status).toBe(400);

    const revocable = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", admin, { name: "ci2" });
    expect((await withKey("GET", "/api/v1/projects", revocable.body.token)).status).toBe(200);
    expect((await api("DELETE", `/api/v1/me/api-keys/${revocable.body.id}`, admin)).status).toBe(200);
    expect((await withKey("GET", "/api/v1/projects", revocable.body.token)).status).toBe(401);

    expect((await withKey("GET", "/api/v1/projects", created.body.token)).status).toBe(200);
    context.advance(25 * 60 * 60 * 1000);
    expect((await withKey("GET", "/api/v1/projects", created.body.token)).status).toBe(401);
  });

  it("follows the owner's rights, its projects and its level", async () => {
    const { cookie } = await createMember("o@example.com", [{ project: "shop", role: "operator" }]);
    const readKey = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", cookie, {
      name: "read",
      level: "read",
      projects: ["shop"],
    });
    expect(readKey.status).toBe(201);

    // A key can't be made wider than its owner.
    const wider = await api("POST", "/api/v1/me/api-keys", cookie, { name: "wide", projects: ["secret"] });
    expect(wider.status).toBe(400);

    expect((await withKey("GET", "/api/v1/projects/shop", readKey.body.token)).status).toBe(200);
    expect((await withKey("GET", "/api/v1/projects/secret", readKey.body.token)).status).toBe(404);

    const write = await withKey("POST", "/api/v1/projects/shop/services/web/deploy", readKey.body.token, {});
    expect(write.status).toBe(403);
    expect(apiErrorOf(write).code).toBe("read_only_key");
  });

  it("gives an admin key no way to touch accounts, settings or other keys", async () => {
    const key = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", admin, {
      name: "admin",
      level: "write",
    });
    for (const [method, path] of [
      ["GET", "/api/v1/users"],
      ["GET", "/api/v1/me/api-keys"],
      ["GET", "/api/v1/server/overview"],
      ["PUT", "/api/v1/settings/github"],
    ] as const) {
      const result = await withKey(
        method,
        path,
        key.body.token,
        method === "PUT" ? { token: "x" } : undefined,
      );
      expect(result.status, path).toBe(403);
      expect(apiErrorOf(result).code).toBe("session_required");
    }
    // It can still do the operations it exists for.
    expect((await withKey("GET", "/api/v1/projects/shop", key.body.token)).status).toBe(200);
  });

  it("gives an admin key no way to update the panel or change the server's routes", async () => {
    const key = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", admin, {
      name: "admin",
      level: "write",
    });
    for (const [method, path, body] of [
      ["GET", "/api/v1/system/update", undefined],
      ["POST", "/api/v1/system/update/check", undefined],
      ["POST", "/api/v1/system/update", { confirm: "x" }],
      ["POST", "/api/v1/system/update/rollback", { confirm: "x" }],
      ["POST", "/api/v1/domains/custom", { host: "x.example.com", servers: [{ url: "http://10.0.0.1:80" }] }],
      ["DELETE", "/api/v1/domains/custom/some-id", undefined],
    ] as const) {
      const result = await withKey(method, path, key.body.token, body);
      expect(result.status, `${method} ${path}`).toBe(403);
      expect(apiErrorOf(result).code, `${method} ${path}`).toBe("session_required");
    }
    // Reading the routes and information about the panel stay open to it.
    expect((await withKey("GET", "/api/v1/domains", key.body.token)).status).toBe(200);
    expect((await withKey("GET", "/api/v1/system/info", key.body.token)).status).toBe(200);
  });

  it("confines a project-scoped key to its projects, even for an administrator", async () => {
    const key = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", admin, {
      name: "p",
      projects: ["shop"],
    });
    expect((await withKey("GET", "/api/v1/projects/secret", key.body.token)).status).toBe(404);
    expect((await withKey("GET", "/api/v1/monitor/system", key.body.token)).status).toBe(403);
    const list = await withKey<ProjectList>("GET", "/api/v1/projects", key.body.token);
    expect(list.body.projects.map((project) => project.name)).toEqual(["shop"]);
  });

  it("is revoked when the owner's password changes", async () => {
    const key = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", admin, { name: "ci" });
    const changed = await authPost(
      context.app,
      "credentials",
      {
        email: "admin@example.com",
        currentPassword: TEST_PASSWORD,
        newPassword: "an entirely new passphrase",
      },
      admin,
    );
    expect(changed.status).toBe(200);
    expect((await withKey("GET", "/api/v1/projects", key.body.token)).status).toBe(401);
  });
});

describe("recovering an account", () => {
  it("issues a new password on the server and ends what the old one had", async () => {
    const key = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", admin, { name: "ci" });
    const result = await resetPassword(context.deps.config, undefined, {
      open: () => ({ db: context.deps.db, close: () => {} }),
    });
    expect(result.email).toBe("admin@example.com");
    expect((await withKey("GET", "/api/v1/projects", key.body.token)).status).toBe(401);
    expect((await api("GET", "/api/v1/projects", admin)).status).toBe(401);
    const login = await authPost(context.app, "login", { email: result.email, password: result.password });
    expect(login.status).toBe(200);
  });

  it("names the account it cannot find", async () => {
    await expect(
      resetPassword(context.deps.config, "nobody@example.com", {
        open: () => ({ db: context.deps.db, close: () => {} }),
      }),
    ).rejects.toThrow(ResetPasswordError);
  });
});

describe("the domains overview", () => {
  it("says which projects the caller may change", async () => {
    const viewer = await createMember("v@example.com", [{ project: "shop", role: "viewer" }]);
    const operator = await createMember("o2@example.com", [{ project: "shop", role: "operator" }]);

    const asViewer = await api<DomainsOverview>("GET", "/api/v1/domains", viewer.cookie);
    const asOperator = await api<DomainsOverview>("GET", "/api/v1/domains", operator.cookie);
    const asAdmin = await api<DomainsOverview>("GET", "/api/v1/domains", admin);

    expect(asViewer.body.managedProjects).toEqual([]);
    expect(asOperator.body.managedProjects).toEqual(["shop"]);
    expect(asAdmin.body.managedProjects).toBeNull();
  });
});

describe("realtime topics", () => {
  it("lets a member listen only to what their routes would show them", async () => {
    const { user } = await createMember("t@example.com", [{ project: "shop", role: "viewer" }]);
    const guard = createTopicGuard(context.deps);

    expect(guard.allow(user.id, servicesMetricsTopic)).toBe(false);
    expect(guard.allow(user.id, dockerEventsTopic)).toBe(false);
    expect(guard.allow(user.id, serviceMetricsTopic("shop", "web"))).toBe(true);
    expect(guard.allow(user.id, serviceMetricsTopic("secret", "web"))).toBe(false);
    // A viewer sees states, not logs.
    expect(guard.allow(user.id, serviceLogsTopic("shop", "web"))).toBe(false);
    expect(guard.allow(user.id, actionsTopic)).toBe(true);
    expect(guard.deliver?.(user.id, actionsTopic, { projectName: "secret", actorEmail: null })).toBe(false);
    expect(guard.deliver?.(user.id, actionsTopic, { projectName: "shop", actorEmail: null })).toBe(true);
  });

  it("lets an operator follow the logs of their own projects", async () => {
    const { user } = await createMember("o@example.com", [{ project: "shop", role: "operator" }]);
    const guard = createTopicGuard(context.deps);

    expect(guard.allow(user.id, serviceLogsTopic("shop", "web"))).toBe(true);
    expect(guard.allow(user.id, serviceLogsTopic("secret", "web"))).toBe(false);
  });
});

describe("the policy table", () => {
  it("denies by default", () => {
    expect(requirementFor("GET", "/api/v1/some-future-feature")).toEqual({ kind: "admin", session: false });
    expect(requirementFor("GET", "/api/v1/health")).toEqual({ kind: "open" });
    expect(requirementFor("GET", "/api/v1/projects/shop/services/web/some-new-tab")).toMatchObject({
      kind: "project",
      level: "operator",
    });
  });

  it("gives viewers only the inventory", () => {
    expect(requirementFor("GET", "/api/v1/projects/shop")).toMatchObject({ level: "viewer" });
    expect(requirementFor("GET", "/api/v1/projects/shop/services/web")).toMatchObject({ level: "viewer" });
    expect(requirementFor("GET", "/api/v1/projects/shop/services/web/environment")).toMatchObject({
      level: "operator",
    });
    expect(requirementFor("POST", "/api/v1/projects/shop/services/web")).toMatchObject({ level: "operator" });
  });
});
