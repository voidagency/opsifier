import { createHash } from "node:crypto";
import { type AddressInfo, createServer as createNetServer, type Server as NetServer } from "node:net";
import type {
  ActionEntry,
  CreatedApiKey,
  CreatedInvitations,
  InvitationList,
  InvitationPreview,
  NotificationChannel,
  PanelUser,
  ResentInvitation,
  SessionState,
  UserList,
} from "@opsifier/contract";
import { defaultNotificationEvents, INVITATION_DAYS } from "@opsifier/contract";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { invitations, settings, users } from "../../core/db/schema";
import {
  apiErrorOf,
  authPost,
  call,
  createTestContext,
  setupAdmin,
  TEST_EMAIL,
  TEST_NAME,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
} from "../../testing/harness";
import { SERVER_IP_KEY } from "../system/service";
import { invitationMail } from "./mail";
import * as repo from "./repo";

const DAY_MS = 24 * 60 * 60 * 1000;
const PASSWORD = "a fine long password";

let context: TestContext;
let admin: string;

beforeEach(async () => {
  context = await createTestContext();
  admin = await setupAdmin(context.app);
  expect((await api("POST", "/api/v1/projects", admin, { name: "shop" })).status).toBe(201);
});

afterEach(async () => {
  await context.close();
});

function api<T = unknown>(method: string, path: string, cookie: string | undefined, body?: unknown) {
  return call<T>(context.app, path, { method, cookie, body, origin: TEST_ORIGIN });
}

const invite = (body: unknown, cookie = admin) =>
  api<CreatedInvitations>("POST", "/api/v1/users/invitations", cookie, body);
const listInvitations = (cookie = admin) => api<InvitationList>("GET", "/api/v1/users/invitations", cookie);
const resend = (id: string, body: unknown = {}) =>
  api<ResentInvitation>("POST", `/api/v1/users/invitations/${id}/resend`, admin, body);
const check = (token: string) => authPost<InvitationPreview>(context.app, "invitation/check", { token });
const accept = (token: string, name = "Ann Example", password = PASSWORD) =>
  authPost<SessionState>(context.app, "invitation/accept", { token, name, password });

const tokenOf = (link: string | null | undefined) => (link ?? "").split("#")[1] ?? "";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function inviteOne(
  email: string,
  extra: Record<string, unknown> = {},
  cookie = admin,
): Promise<string> {
  const created = await invite({ emails: [email], ...extra }, cookie);
  expect(created.status).toBe(201);
  expect(created.body.results[0]?.outcome).toBe("invited");
  return tokenOf(created.body.results[0]?.link);
}

async function signIn(email: string, role: "admin" | "member"): Promise<{ id: string; cookie: string }> {
  const created = await api<PanelUser>("POST", "/api/v1/users", admin, {
    email,
    password: TEST_PASSWORD,
    role,
  });
  expect(created.status).toBe(201);
  const login = await authPost(context.app, "login", { email, password: TEST_PASSWORD });
  expect(login.status).toBe(200);
  return { id: created.body.id, cookie: login.cookie as string };
}

/** Where the panel says it answers: links point there. */
async function panelUrl(): Promise<string | null> {
  return (await api<{ url: string | null }>("GET", "/api/v1/server/panel-domain", admin)).body.url;
}

/** After the clock has moved past the administrator's session. */
async function signInAgain(): Promise<void> {
  const login = await authPost(context.app, "login", { email: TEST_EMAIL, password: TEST_PASSWORD });
  expect(login.status).toBe(200);
  admin = login.cookie as string;
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  expect(condition()).toBe(true);
}

async function waitForAction(id: string): Promise<ActionEntry & { log: string }> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const { body } = await api<ActionEntry & { log: string }>("GET", `/api/v1/actions/${id}`, admin);
    if (body.status !== "queued" && body.status !== "running") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
  throw new Error("The action did not finish");
}

describe("inviting", () => {
  it("invites a list of people, and reports what it leaves alone without stopping", async () => {
    const created = await invite({
      emails: ["Ann@Example.com", "bob@example.com", "ANN@example.com", TEST_EMAIL.toUpperCase()],
      role: "member",
      projects: [{ project: "shop", role: "operator" }],
    });

    expect(created.status).toBe(201);
    expect(created.body.results.map((result) => [result.email, result.outcome])).toEqual([
      ["ann@example.com", "invited"],
      ["bob@example.com", "invited"],
      ["ann@example.com", "duplicate"],
      [TEST_EMAIL, "account_exists"],
    ]);
    expect(created.body.action).toBeNull();
    const [ann, bob, duplicate] = created.body.results;
    expect(ann?.link?.startsWith(`${await panelUrl()}/invitation#`)).toBe(true);
    expect(tokenOf(ann?.link)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(duplicate).toMatchObject({ invitation: null, link: null });
    expect(ann?.invitation).toMatchObject({
      email: "ann@example.com",
      role: "member",
      projects: [{ project: "shop", role: "operator" }],
      invitedBy: TEST_EMAIL,
      delivery: "link",
      channelName: null,
      expired: false,
    });
    const term = Date.parse(ann?.invitation?.expiresAt ?? "") - Date.parse(ann?.invitation?.createdAt ?? "");
    expect(term).toBe(INVITATION_DAYS * DAY_MS);

    // Only the hash of each link is kept, and no list ever shows one.
    const rows = context.deps.db.select().from(invitations).all();
    expect(rows.map((row) => row.tokenHash).sort()).toEqual(
      [sha256(tokenOf(ann?.link)), sha256(tokenOf(bob?.link))].sort(),
    );
    expect(JSON.stringify(rows)).not.toContain(tokenOf(ann?.link));
    const list = await listInvitations();
    expect(list.body.invitations.map((invitation) => invitation.email)).toEqual([
      "ann@example.com",
      "bob@example.com",
    ]);
    expect(JSON.stringify(list.body)).not.toContain(tokenOf(ann?.link));

    const again = await invite({ emails: ["ann@example.com", "carol@example.com"] });
    expect(again.body.results.map((result) => result.outcome)).toEqual(["already_invited", "invited"]);
  });

  it("gives an administrator's invitation no project list", async () => {
    const token = await inviteOne("root@example.com", {
      role: "admin",
      projects: [{ project: "shop", role: "viewer" }],
    });
    expect((await listInvitations()).body.invitations[0]).toMatchObject({ role: "admin", projects: [] });

    expect((await accept(token)).body).toMatchObject({ status: "signed-in", user: { role: "admin" } });
  });

  it("refuses what it can't act on, and invites nobody then", async () => {
    expect(Object.keys(apiErrorOf(await invite({ emails: [] })).fields ?? {})).toContain("emails");
    expect(apiErrorOf(await invite({ emails: ["ok@example.com", "not an address"] })).fields).toHaveProperty([
      "emails.1",
    ]);
    const many = Array.from({ length: 101 }, (_, index) => `person${index}@example.com`);
    expect((await invite({ emails: many })).status).toBe(400);
    expect(
      apiErrorOf(await invite({ emails: ["x@example.com"], projects: [{ project: "nope", role: "viewer" }] }))
        .fields,
    ).toHaveProperty("projects");
    expect(apiErrorOf(await invite({ emails: ["x@example.com"], channel: "nope" })).fields).toHaveProperty(
      "channel",
    );
    expect((await invite({ emails: ["x@example.com"], password: "set by me" })).status).toBe(400);

    expect((await listInvitations()).body.invitations).toEqual([]);
  });

  it("is for administrators at a browser", async () => {
    const member = await signIn("member@example.com", "member");
    expect((await listInvitations(member.cookie)).status).toBe(403);
    expect((await invite({ emails: ["x@example.com"] }, member.cookie)).status).toBe(403);

    const key = await api<CreatedApiKey>("POST", "/api/v1/me/api-keys", admin, {
      name: "ci",
      level: "write",
    });
    const withKey = await call(context.app, "/api/v1/users/invitations", {
      method: "POST",
      headers: { authorization: `Bearer ${key.body.token}` },
      body: { emails: ["x@example.com"] },
    });
    expect(withKey.status).toBe(403);
    expect((await listInvitations()).body.invitations).toEqual([]);
  });
});

describe("accepting", () => {
  it("creates the account the invitation describes, signs it in and uses the link up", async () => {
    const token = await inviteOne("ann@example.com", { projects: [{ project: "shop", role: "viewer" }] });

    const preview = await check(token);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ email: "ann@example.com", role: "member", invitedBy: TEST_NAME });

    const accepted = await accept(token, "  Ann Example ");
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ status: "signed-in", user: { email: "ann@example.com" } });
    const session = await call<SessionState>(context.app, "/api/v1/auth/session", {
      cookie: accepted.cookie,
    });
    expect(session.body).toMatchObject({ status: "signed-in", user: { email: "ann@example.com" } });

    const everyone = await api<UserList>("GET", "/api/v1/users", admin);
    expect(everyone.body.users.find((user) => user.email === "ann@example.com")).toMatchObject({
      name: "Ann Example",
      role: "member",
      projects: [{ project: "shop", role: "viewer" }],
    });
    expect((await listInvitations()).body.invitations).toEqual([]);

    expect(apiErrorOf(await check(token)).code).toBe("invitation_invalid");
    expect((await accept(token)).status).toBe(404);
    expect(
      (await authPost(context.app, "login", { email: "ann@example.com", password: PASSWORD })).status,
    ).toBe(200);
  });

  it("leaves out a project deleted since, and refuses a weak password", async () => {
    expect((await api("POST", "/api/v1/projects", admin, { name: "gone" })).status).toBe(201);
    const token = await inviteOne("ann@example.com", {
      projects: [
        { project: "shop", role: "operator" },
        { project: "gone", role: "viewer" },
      ],
    });
    const removal = await api<ActionEntry>("DELETE", "/api/v1/projects/gone", admin, { confirm: "gone" });
    expect(removal.status).toBe(202);
    expect((await waitForAction(removal.body.id)).status).toBe("succeeded");

    expect(apiErrorOf(await accept(token, "Ann", "short")).fields).toHaveProperty("password");
    expect(apiErrorOf(await accept(token, "Ann", " ".repeat(12))).fields).toHaveProperty("password");
    expect((await accept(token, "Ann")).status).toBe(201);
    const everyone = await api<UserList>("GET", "/api/v1/users", admin);
    expect(everyone.body.users.find((user) => user.email === "ann@example.com")?.projects).toEqual([
      { project: "shop", role: "operator" },
    ]);
  });

  it("refuses a link nobody issued, and slows down whoever tries them", async () => {
    await context.close();
    context = await createTestContext({ authLimits: { loginPerAddress: { limit: 3, windowMs: DAY_MS } } });
    admin = await setupAdmin(context.app);
    const token = await inviteOne("ann@example.com");

    expect(apiErrorOf(await check("not-a-token")).code).toBe("invitation_invalid");
    // A link that works costs nothing.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await check(token)).status).toBe(200);
    }
    expect(apiErrorOf(await accept("x".repeat(43))).code).toBe("invitation_invalid");
    expect((await check("y".repeat(43))).status).toBe(404);
    expect((await check("z".repeat(43))).status).toBe(429);
  });

  it("refuses an address that has an account since", async () => {
    const token = await inviteOne("ann@example.com");
    await signIn("ann@example.com", "member");

    expect(apiErrorOf(await accept(token)).code).toBe("email_taken");
  });
});

describe("keeping invitations", () => {
  it("lets a link expire, and sending again gives a new one in place of the old", async () => {
    const token = await inviteOne("ann@example.com");
    context.advance(INVITATION_DAYS * DAY_MS + 1);
    await signInAgain();

    expect((await check(token)).status).toBe(404);
    const [expired] = (await listInvitations()).body.invitations;
    expect(expired?.expired).toBe(true);

    const resent = await resend(expired?.id ?? "");
    expect(resent.status).toBe(200);
    expect(resent.body).toMatchObject({ action: null, invitation: { expired: false, delivery: "link" } });
    const fresh = tokenOf(resent.body.link);
    expect(fresh).not.toBe(token);
    expect((await check(fresh)).status).toBe(200);

    const newer = await resend(expired?.id ?? "");
    expect((await check(fresh)).status).toBe(404);
    expect((await check(tokenOf(newer.body.link))).status).toBe(200);
  });

  it("replaces an expired invitation when the address is invited again", async () => {
    await inviteOne("ann@example.com");
    context.advance(INVITATION_DAYS * DAY_MS + 1);
    await signInAgain();

    const token = await inviteOne("ann@example.com");
    expect((await listInvitations()).body.invitations).toHaveLength(1);
    expect((await check(token)).status).toBe(200);
  });

  it("takes an invitation back", async () => {
    const token = await inviteOne("ann@example.com");
    const [pending] = (await listInvitations()).body.invitations;

    expect((await api("DELETE", `/api/v1/users/invitations/${pending?.id}`, admin)).status).toBe(200);
    expect(apiErrorOf(await accept(token)).code).toBe("invitation_invalid");
    expect((await api("DELETE", `/api/v1/users/invitations/${pending?.id}`, admin)).status).toBe(404);
    expect((await resend(pending?.id ?? "")).status).toBe(404);
  });

  it("ends an invitation with its sender's administrator rights", async () => {
    const demoted = await signIn("demoted@example.com", "admin");
    const deactivated = await signIn("deactivated@example.com", "admin");
    const deleted = await signIn("deleted@example.com", "admin");
    const changed = await signIn("changed@example.com", "admin");
    const fromDemoted = await inviteOne("a@example.com", {}, demoted.cookie);
    const fromDeactivated = await inviteOne("b@example.com", {}, deactivated.cookie);
    const fromDeleted = await inviteOne("c@example.com", {}, deleted.cookie);
    const fromChanged = await inviteOne("d@example.com", {}, changed.cookie);
    const fromOwner = await inviteOne("e@example.com");

    await api("PUT", `/api/v1/users/${demoted.id}`, admin, {
      email: "demoted@example.com",
      role: "member",
      projects: [],
    });
    await api("POST", `/api/v1/users/${deactivated.id}/active`, admin, { active: false });
    await api("DELETE", `/api/v1/users/${deleted.id}`, admin, { confirm: "deleted@example.com" });
    // However the rights went, the link checks them again.
    context.deps.db.update(users).set({ role: "member" }).where(eq(users.id, changed.id)).run();

    for (const token of [fromDemoted, fromDeactivated, fromDeleted, fromChanged]) {
      expect((await check(token)).status).toBe(404);
    }
    expect((await check(fromOwner)).status).toBe(200);
    expect((await listInvitations()).body.invitations.map((invitation) => invitation.email)).toEqual([
      "d@example.com",
      "e@example.com",
    ]);
  });
});

describe("e-mailing the links", () => {
  let smtp: NetServer | undefined;
  let lines: string[] = [];
  let refused = new Set<string>();
  /** Holds the greeting back, so a test can act while an e-mail waits at the door. */
  let gate: Promise<void> | undefined;
  let connections = 0;

  afterEach(() => {
    smtp?.close();
    smtp = undefined;
    lines = [];
    refused = new Set();
    gate = undefined;
    connections = 0;
  });

  /** Speaks just enough SMTP, and refuses the recipients in `refused`. */
  async function startSmtpStub(): Promise<number> {
    smtp = createNetServer((socket) => {
      connections += 1;
      void (gate ?? Promise.resolve()).then(() => socket.write("220 stub ESMTP\r\n"));
      let buffer = "";
      let inData = false;
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (let end = buffer.indexOf("\r\n"); end !== -1; end = buffer.indexOf("\r\n")) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          lines.push(line);
          const recipient = /^RCPT TO:<(.+)>$/.exec(line)?.[1];
          if (inData) {
            if (line === ".") {
              inData = false;
              socket.write("250 Queued as 42\r\n");
            }
          } else if (line.startsWith("EHLO")) {
            socket.write("250-stub\r\n250 8BITMIME\r\n");
          } else if (line === "STARTTLS") {
            socket.write("502 Not implemented\r\n");
          } else if (recipient !== undefined && refused.has(recipient)) {
            socket.write("550 No such mailbox\r\n");
          } else if (line === "DATA") {
            inData = true;
            socket.write("354 Go ahead\r\n");
          } else if (line === "QUIT") {
            socket.end("221 Bye\r\n");
          } else {
            socket.write("250 OK\r\n");
          }
        }
      });
    });
    await new Promise<void>((resolve) => smtp?.listen(0, "127.0.0.1", resolve));
    return (smtp.address() as AddressInfo).port;
  }

  async function smtpChannel(): Promise<string> {
    const port = await startSmtpStub();
    await api("PUT", "/api/v1/notifications/settings", admin, { allowPrivateDestinations: true });
    const created = await api<NotificationChannel>("POST", "/api/v1/notifications/channels", admin, {
      name: "Team mail",
      config: {
        type: "smtp",
        host: "127.0.0.1",
        port,
        from: "panel@example.test",
        recipients: ["owner@example.test"],
      },
      events: defaultNotificationEvents,
    });
    expect(created.status).toBe(201);
    return created.body.id;
  }

  it("sends each link to the person invited, and only there", async () => {
    const channel = await smtpChannel();
    const created = await invite({ emails: ["ann@example.com", "bob@example.com"], channel, language: "fr" });

    expect(created.status).toBe(201);
    expect(created.body.results.map((result) => result.link)).toEqual([null, null]);
    expect(created.body.results[0]?.invitation).toMatchObject({
      delivery: "sending",
      channelName: "Team mail",
    });
    const finished = await waitForAction(created.body.action?.id ?? "");
    expect(finished.status).toBe("succeeded");

    expect(lines).toContain("MAIL FROM:<panel@example.test>");
    expect(lines).toContain("RCPT TO:<ann@example.com>");
    expect(lines).toContain("RCPT TO:<bob@example.com>");
    expect(lines).not.toContain("RCPT TO:<owner@example.test>");
    expect(lines.some((line) => line.startsWith(`${TEST_EMAIL} vous invite`))).toBe(true);
    // Nothing in it is free text: not even the name the administrator chose for themselves.
    expect(lines.some((line) => line.includes(TEST_NAME))).toBe(false);
    const base = await panelUrl();
    const links = lines.filter((line) => line.startsWith(`${base}/invitation#`));
    expect(links).toHaveLength(2);
    expect((await check(tokenOf(links[0]))).body).toMatchObject({ email: "ann@example.com" });
    expect(finished.log).not.toContain(tokenOf(links[0]));

    const list = (await listInvitations()).body.invitations;
    expect(list.map((invitation) => [invitation.delivery, invitation.error])).toEqual([
      ["sent", null],
      ["sent", null],
    ]);
    expect(list.every((invitation) => invitation.sentAt !== null)).toBe(true);
  });

  it("records an e-mail the server refused, and can hand over a link instead", async () => {
    refused.add("bob@example.com");
    const channel = await smtpChannel();
    const created = await invite({ emails: ["ann@example.com", "bob@example.com"], channel });

    const finished = await waitForAction(created.body.action?.id ?? "");
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("1 of 2");
    const list = (await listInvitations()).body.invitations;
    expect(list.find((invitation) => invitation.email === "ann@example.com")?.delivery).toBe("sent");
    const bob = list.find((invitation) => invitation.email === "bob@example.com");
    expect(bob).toMatchObject({ delivery: "failed", error: expect.stringContaining("550") });

    const resent = await resend(bob?.id ?? "", { channel: null });
    expect(resent.body).toMatchObject({ action: null, invitation: { delivery: "link", error: null } });
    expect((await check(tokenOf(resent.body.link))).status).toBe(200);
  });

  it("does not send a link that was replaced before its turn came", async () => {
    let release: () => void = () => {};
    gate = new Promise((resolve) => {
      release = resolve;
    });
    const channel = await smtpChannel();
    const created = await invite({ emails: ["ann@example.com", "bob@example.com"], channel });
    // The first e-mail waits at the mail server's door while the second invitation gets a new link.
    await until(() => connections > 0);
    const resent = await resend(created.body.results[1]?.invitation?.id ?? "", { channel: null });
    release();

    const finished = await waitForAction(created.body.action?.id ?? "");
    expect(finished.status).toBe("succeeded");
    expect(finished.log).toContain("Skipped bob@example.com");
    expect(lines).toContain("RCPT TO:<ann@example.com>");
    expect(lines).not.toContain("RCPT TO:<bob@example.com>");
    const bob = (await listInvitations()).body.invitations.find((entry) => entry.email === "bob@example.com");
    expect(bob?.delivery).toBe("link");
    expect((await check(tokenOf(resent.body.link))).status).toBe(200);
  });

  it("only ever e-mails a link to the panel itself", async () => {
    const channel = await smtpChannel();
    const base = await panelUrl();
    // Reached under another name: the request is consistent, and names a host that is not the panel.
    const elsewhere = (body: unknown) =>
      call<CreatedInvitations>(context.app, "http://elsewhere.example/api/v1/users/invitations", {
        method: "POST",
        cookie: admin,
        origin: "http://elsewhere.example",
        body,
      });

    const mailed = await elsewhere({ emails: ["ann@example.com"], channel });
    expect(mailed.status).toBe(201);
    await waitForAction(mailed.body.action?.id ?? "");
    expect(lines.some((line) => line.startsWith(`${base}/invitation#`))).toBe(true);
    expect(lines.some((line) => line.includes("elsewhere.example"))).toBe(false);

    // With no address of its own, the panel e-mails a link only when it is reached on this machine.
    context.deps.db.delete(settings).where(eq(settings.key, SERVER_IP_KEY)).run();
    expect(await panelUrl()).toBeNull();
    expect(apiErrorOf(await elsewhere({ emails: ["bob@example.com"], channel })).code).toBe(
      "panel_address_unknown",
    );
    expect((await listInvitations()).body.invitations.map((invitation) => invitation.email)).toEqual([
      "ann@example.com",
    ]);
    const local = await invite({ emails: ["bob@example.com"], channel });
    await waitForAction(local.body.action?.id ?? "");
    expect(lines.some((line) => line.startsWith("http://localhost/invitation#"))).toBe(true);
    // A link handed over goes only where the administrator passes it.
    expect((await elsewhere({ emails: ["carol@example.com"] })).body.results[0]?.link).toMatch(
      /^http:\/\/elsewhere\.example\/invitation#/,
    );
  });

  it("gives up on e-mails a restart interrupted", async () => {
    const token = await inviteOne("ann@example.com");
    const [row] = context.deps.db.select().from(invitations).all();
    repo.updateInvitation(context.deps.db, row?.id ?? "", { delivery: "sending", channelName: "Team mail" });

    const next = await context.restart();
    const list = await call<InvitationList>(next.app, "/api/v1/users/invitations", { cookie: admin });
    expect(list.body.invitations[0]).toMatchObject({
      delivery: "failed",
      error: expect.stringContaining("restarted"),
    });
    expect((await authPost(next.app, "invitation/check", { token })).status).toBe(200);
  });
});

describe("the invitation e-mail", () => {
  const input = {
    inviter: "admin@example.com",
    panel: "panel.example.com",
    link: "https://panel.example.com/invitation#abc",
    expiresAt: new Date("2026-11-19T14:05:00Z"),
  };

  it("says who invites, where, as what and until when", () => {
    const mail = invitationMail({ ...input, role: "member", language: "en" });

    expect(mail.subject).toBe("Your invitation to Opsifier on panel.example.com");
    expect(mail.body).toContain(
      "admin@example.com has invited you to the Opsifier panel at panel.example.com, as a member.",
    );
    expect(mail.body).toContain("\nhttps://panel.example.com/invitation#abc\n");
    expect(mail.body).toContain("until 19 November 2026 at 14:05 UTC");
  });

  it("speaks French", () => {
    const mail = invitationMail({ ...input, role: "admin", language: "fr" });

    expect(mail.subject).toBe("Votre invitation à Opsifier sur panel.example.com");
    expect(mail.body).toContain("vous invite à rejoindre le panneau Opsifier de panel.example.com");
    expect(mail.body).toContain("en tant qu'administrateur.");
    expect(mail.body).toContain("jusqu'au 19 novembre 2026 à 14:05 UTC");
  });
});
