import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ActionPage,
  CreatedStudioGuestLink,
  StudioGuestLinkList,
  StudioPreviewRemarks,
  StudioRemark,
  StudioRemarkList,
  StudioSettings,
} from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiErrorOf,
  authPost,
  type CallResult,
  call,
  createTestContext,
  setupAdmin,
  signInMember,
  TEST_EMAIL,
  TEST_ORIGIN,
  TEST_PASSWORD,
  type TestContext,
} from "../../testing/harness";

let context: TestContext;
let cookie: string;

const api = <T = unknown>(path: string, method = "GET", body?: unknown, as = cookie) =>
  call<T>(context.app, `/api/v1${path}`, { method, body, cookie: as, origin: TEST_ORIGIN });

const HOST = "preview.example.com";
const OTHER_HOST = "other.example.com";
const PREVIEW = "/projects/lovable/services/cd-studio-preview";
const OTHER = "/projects/lovable/services/other-preview";
const AGENT = {
  project: "lovable",
  service: "openhands",
  url: "http://127.0.0.1:18000",
  keyFile: null,
  projectsDir: null,
};
const ROUTES = () =>
  readFileSync(join(context.deps.config.traefikDynamicDir, "lovable__cd-studio-preview.yaml"), "utf8");

/** A request to the preview's own address, as the proxy passes it to the panel. */
function onPreview<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string; origin?: string; host?: string } = {},
): Promise<CallResult<T>> {
  const host = options.host ?? HOST;
  return call<T>(context.app, `http://${host}/api/proxy-pages/studio${path}`, {
    method: options.method,
    body: options.body,
    cookie: options.cookie,
    origin: options.origin,
    headers: { host },
  });
}

const tokenOf = (url: string) => url.split("/__opsifier/studio/link/")[1] ?? "";
const remark = (text: string, path = "/comptes?remarks=1") => ({
  path,
  text,
  element: {
    tag: "BUTTON",
    text: "Ouvrir un compte",
    classes: ["btn", "btn-primary"],
    attributes: { type: "button", onclick: "steal()", "data-x": "x" },
    selector: "main > section:nth-of-type(2) > button.btn",
    components: ["Hero", "App"],
    path: "/comptes",
  },
  point: { x: 0.5, y: 0.25 },
  viewport: { width: 390, height: 844 },
});

async function prepare(): Promise<void> {
  for (const [service, host] of [
    ["cd-studio-preview", HOST],
    ["other-preview", OTHER_HOST],
  ] as const) {
    await api("/projects/lovable/services", "POST", { name: service });
    expect((await api(`/projects/lovable/services/${service}/domains`, "POST", { host })).status).toBe(201);
  }
  expect((await api("/settings/studio", "PUT", { enabled: true, agent: AGENT })).status).toBe(200);
  expect((await api(`${PREVIEW}/studio`, "PUT", { workspaceDir: "/projects/cd-studio" })).status).toBe(200);
  expect((await api(`${OTHER}/studio`, "PUT", { workspaceDir: "/projects/other" })).status).toBe(200);
}

/** A link made in the Studio, opened by the client: their cookie for the preview. */
async function openLink(label = "Karim Benali · Acme", days: number | null = 30): Promise<string> {
  const made = await api<CreatedStudioGuestLink>(`${PREVIEW}/studio/links`, "POST", { label, days });
  expect(made.status).toBe(201);
  const opened = await onPreview(`/link/${tokenOf(made.body.url)}`);
  expect(opened.status).toBe(302);
  return opened.cookie ?? "";
}

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
  await api("/projects", "POST", { name: "lovable" });
  await api("/projects/lovable/services", "POST", { name: "openhands" });
  await prepare();
});

afterEach(async () => {
  await context.close();
});

describe("a Studio preview's routes", () => {
  it("send its address's /__opsifier/studio/ to the panel, with the previews' sign-in off", () => {
    expect(ROUTES()).toContain("PathPrefix(`/__opsifier/studio/`)");
    expect(ROUTES()).toContain("replacePathRegex");
    expect(ROUTES()).not.toContain("forwardAuth");
  });

  it("lose them once the project leaves the Studio", async () => {
    expect((await api(`${PREVIEW}/studio`, "DELETE")).status).toBe(200);

    expect(ROUTES()).not.toContain("/__opsifier/studio/");
  });
});

describe("a link for a client", () => {
  it("is shown once, then listed without its address", async () => {
    const made = await api<CreatedStudioGuestLink>(`${PREVIEW}/studio/links`, "POST", {
      label: "Karim Benali · Acme",
    });

    expect(made.status).toBe(201);
    // On the preview's primary address: here the one the server gives each service.
    expect(made.body.url).toMatch(/^https:\/\/[a-z0-9.-]+\/__opsifier\/studio\/link\/[\w-]{32}$/);
    expect(made.body.remarks).toBe(true);
    expect(made.body.createdBy).toBe("admin@example.com");
    const days = (Date.parse(made.body.expiresAt ?? "") - Date.parse(made.body.createdAt)) / 86_400_000;
    expect(days).toBe(30);

    const list = await api<StudioGuestLinkList>(`${PREVIEW}/studio/links`);
    expect(list.body.links).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(tokenOf(made.body.url));
    const actions = await api<ActionPage>("/actions?limit=20");
    expect(actions.body.items.some((action) => action.type === "studio.guest-link")).toBe(true);
  });

  it("gives the client a cookie of the preview's own, and lands on the remarks tool", async () => {
    const made = await api<CreatedStudioGuestLink>(`${PREVIEW}/studio/links`, "POST", {
      label: "Karim",
    });

    const opened = await onPreview(`/link/${tokenOf(made.body.url)}`);

    expect(opened.status).toBe(302);
    expect(opened.headers.get("location")).toBe("/?remarks=1");
    const cookies = opened.headers.getSetCookie();
    expect(cookies[0]).toContain("opsifier_studio_guest=");
    expect(cookies[0]).toContain("HttpOnly");
    expect(cookies[0]).toContain("SameSite=Lax");
    // The tool's flag, for the inspector to read on whatever page the site's home page sends it to.
    expect(cookies[1]).toMatch(/^opsifier_studio_remarks=1;/);
    expect(cookies[1]).not.toContain("HttpOnly");
    const list = await api<StudioGuestLinkList>(`${PREVIEW}/studio/links`);
    expect(list.body.links[0]?.lastUsedAt).not.toBeNull();
  });

  it("lands on the site alone when made without the remarks tool", async () => {
    const made = await api<CreatedStudioGuestLink>(`${PREVIEW}/studio/links`, "POST", {
      label: "Karim",
      remarks: false,
    });

    const opened = await onPreview(`/link/${tokenOf(made.body.url)}`);

    expect(opened.headers.get("location")).toBe("/");
    expect(opened.headers.getSetCookie().join("\n")).not.toContain("opsifier_studio_remarks");
  });

  it("opens its own preview only, and nothing once taken back or expired", async () => {
    const made = await api<CreatedStudioGuestLink>(`${PREVIEW}/studio/links`, "POST", {
      label: "Karim",
      days: 1,
    });
    const token = tokenOf(made.body.url);

    expect((await onPreview(`/link/${token}`, { host: OTHER_HOST })).status).toBe(404);
    expect((await onPreview("/link/not-a-real-link-at-all")).status).toBe(404);

    context.advance(86_400_001);
    const expired = await onPreview(`/link/${token}`);
    expect(expired.status).toBe(404);
    expect(String(expired.body)).toContain("Lien expiré");
    // A day later, the administrator signs in again.
    cookie =
      (await authPost(context.app, "login", { email: TEST_EMAIL, password: TEST_PASSWORD })).cookie ?? "";
    const list = await api<StudioGuestLinkList>(`${PREVIEW}/studio/links`);
    expect(list.body.links[0]?.expired).toBe(true);

    const kept = await api<CreatedStudioGuestLink>(`${PREVIEW}/studio/links`, "POST", {
      label: "Sara",
      days: null,
    });
    expect(kept.body.expiresAt).toBeNull();
    expect((await api(`${PREVIEW}/studio/links/${kept.body.id}`, "DELETE")).status).toBe(200);
    expect((await onPreview(`/link/${tokenOf(kept.body.url)}`)).status).toBe(404);
  });
});

describe("remarks on a preview", () => {
  it("are written by the link's guest, numbered, and signed with the link's name", async () => {
    const guest = await openLink();

    const empty = await onPreview<StudioPreviewRemarks>("/remarks", { cookie: guest });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ viewer: { name: "Karim Benali · Acme", kind: "guest" }, remarks: [] });

    const first = await onPreview<{ remark: StudioPreviewRemarks["remarks"][number] }>("/remarks", {
      method: "POST",
      body: remark("Le bouton devrait être vert, comme dans la charte."),
      cookie: guest,
      origin: `https://${HOST}`,
    });
    expect(first.status).toBe(201);
    expect(first.body.remark).toMatchObject({
      number: 1,
      path: "/comptes",
      author: "Karim Benali · Acme",
      status: "new",
      mine: true,
      point: { x: 0.5, y: 0.25 },
      viewport: { width: 390, height: 844 },
    });
    // What the page said of the element, kept to its shape: no handler, no path of its own.
    expect(first.body.remark.element).toEqual({
      tag: "button",
      text: "Ouvrir un compte",
      classes: ["btn", "btn-primary"],
      // Only the attributes the inspector describes an element by.
      attributes: { type: "button" },
      selector: "main > section:nth-of-type(2) > button.btn",
      components: ["Hero", "App"],
    });
    const second = await onPreview<{ remark: { number: number } }>("/remarks", {
      method: "POST",
      body: remark("Le titre est trop long", "/"),
      cookie: guest,
      origin: `https://${HOST}`,
    });
    expect(second.body.remark.number).toBe(2);

    const studio = await api<StudioRemarkList>(`${PREVIEW}/studio/remarks`);
    expect(studio.body.remarks.map((one) => [one.number, one.author, one.authorKind, one.status])).toEqual([
      [2, "Karim Benali · Acme", "guest", "new"],
      [1, "Karim Benali · Acme", "guest", "new"],
    ]);
  });

  it("are refused to whoever has no link, and to a page of another site", async () => {
    const guest = await openLink();

    expect((await onPreview("/remarks")).status).toBe(401);
    const sent = (origin: string | undefined, as: string | undefined = guest) =>
      onPreview("/remarks", { method: "POST", body: remark("Bonjour"), cookie: as, origin });
    expect((await sent(undefined)).status).toBe(403);
    expect((await sent("https://evil.example.com")).status).toBe(403);
    expect((await sent(`https://${HOST}`, "")).status).toBe(401);
    // A guest of this preview is nobody on another one.
    expect((await onPreview("/remarks", { cookie: guest, host: OTHER_HOST })).status).toBe(401);
    expect((await sent(`https://${HOST}`)).status).toBe(201);

    const empty = await onPreview("/remarks", {
      method: "POST",
      body: { path: "/", text: "   " },
      cookie: guest,
      origin: `https://${HOST}`,
    });
    expect(empty.status).toBe(400);
  });

  it("follow what the Studio does with them, and their writer may take back one nobody is on", async () => {
    const guest = await openLink();
    const write = async (text: string) =>
      (
        await onPreview<{ remark: { id: string } }>("/remarks", {
          method: "POST",
          body: remark(text),
          cookie: guest,
          origin: `https://${HOST}`,
        })
      ).body.remark.id;
    const handed = await write("Plus de contraste");
    const left = await write("Une faute dans le titre");

    const updated = await api<StudioRemark>(`${PREVIEW}/studio/remarks/${handed}`, "PATCH", {
      status: "in_progress",
      conversationId: "conv-123",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe("in_progress");
    expect(updated.body.conversationId).toBe("conv-123");

    const seen = await onPreview<StudioPreviewRemarks>("/remarks", { cookie: guest });
    expect(seen.body.remarks.map((one) => one.status)).toEqual(["in_progress", "new"]);
    expect(JSON.stringify(seen.body)).not.toContain("conv-123");

    const takeBack = (id: string) =>
      onPreview(`/remarks/${id}`, { method: "DELETE", cookie: guest, origin: `https://${HOST}` });
    expect((await takeBack(handed)).status).toBe(409);
    expect((await takeBack(left)).status).toBe(200);

    const done = await api<StudioRemark>(`${PREVIEW}/studio/remarks/${handed}`, "PATCH", {
      status: "done",
    });
    expect(done.body.conversationId).toBe("conv-123");
    expect((await api(`${PREVIEW}/studio/remarks/${handed}`, "DELETE")).status).toBe(200);
    expect((await api<StudioRemarkList>(`${PREVIEW}/studio/remarks`)).body.remarks).toEqual([]);
  });

  it("stop at once when the link is taken back, and keep what was written", async () => {
    const guest = await openLink();
    await onPreview("/remarks", {
      method: "POST",
      body: remark("Bonjour"),
      cookie: guest,
      origin: `https://${HOST}`,
    });
    const links = await api<StudioGuestLinkList>(`${PREVIEW}/studio/links`);

    await api(`${PREVIEW}/studio/links/${links.body.links[0]?.id}`, "DELETE");

    expect((await onPreview("/remarks", { cookie: guest })).status).toBe(401);
    const kept = await api<StudioRemarkList>(`${PREVIEW}/studio/remarks`);
    expect(kept.body.remarks.map((one) => one.author)).toEqual(["Karim Benali · Acme"]);
  });

  it("are written a few at a time", async () => {
    const guest = await openLink();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const sent = await onPreview("/remarks", {
        method: "POST",
        body: remark(`Remarque ${attempt}`),
        cookie: guest,
        origin: `https://${HOST}`,
      });
      statuses.push(sent.status);
    }

    expect(statuses.filter((status) => status === 201)).toHaveLength(20);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("what a guest writes", () => {
  const post = (guest: string, body: unknown, origin = `https://${HOST}`) =>
    onPreview<{ remark: StudioPreviewRemarks["remarks"][number] }>("/remarks", {
      method: "POST",
      body,
      cookie: guest,
      origin,
    });

  it("never takes a number a remark had before", async () => {
    const guest = await openLink();
    await post(guest, remark("Un"));
    const second = await post(guest, remark("Deux"));
    await onPreview(`/remarks/${second.body.remark.id}`, {
      method: "DELETE",
      cookie: guest,
      origin: `https://${HOST}`,
    });

    const third = await post(guest, remark("Trois"));

    expect(third.body.remark.number).toBe(3);
  });

  it("stays on the preview's own pages, and loses the characters that hide things", async () => {
    const guest = await openLink();

    for (const path of ["/.//evil.example.com/x", "/%2e//evil.example.com", "//evil.example.com"]) {
      const sent = await post(guest, { ...remark("Ici"), path });
      expect(sent.body.remark.path.startsWith("//")).toBe(false);
    }
    const hidden = await post(guest, { ...remark("Plus\u202e de bleu\u0007\r\nmerci"), path: "/" });
    expect(hidden.body.remark.text).toBe("Plus de bleu\nmerci");
  });

  it("comes from the preview's exact origin only", async () => {
    const guest = await openLink();

    expect((await post(guest, remark("Port"), `https://${HOST}:8443`)).status).toBe(403);
    expect((await post(guest, remark("Schéma"), `http://${HOST}`)).status).toBe(403);
    expect((await post(guest, remark("Bon"), `https://${HOST}`)).status).toBe(201);
  });

  it("is kept to a hundred remarks for one link", async () => {
    const guest = await openLink();
    for (let batch = 0; batch < 5; batch += 1) {
      for (let one = 0; one < 20; one += 1) {
        expect((await post(guest, remark(`R${batch}-${one}`))).status).toBe(201);
      }
      context.advance(61_000);
    }

    const over = await post(guest, remark("Encore"));

    expect(over.status).toBe(409);
    expect(apiErrorOf(over).code).toBe("studio_remarks_author_full");
  });

  it("goes with its link when the Studio says so", async () => {
    const guest = await openLink();
    await post(guest, remark("Un"));
    await post(guest, remark("Deux"));
    const links = await api<StudioGuestLinkList>(`${PREVIEW}/studio/links`);
    expect(links.body.links[0]?.remarkCount).toBe(2);

    await api(`${PREVIEW}/studio/links/${links.body.links[0]?.id}?remarks=delete`, "DELETE");

    expect((await api<StudioRemarkList>(`${PREVIEW}/studio/remarks`)).body.remarks).toEqual([]);
  });
});

describe("a guest whose link is gone", () => {
  it("is told so once, its cookie goes, and the team's sign-in is offered", async () => {
    await api("/settings/studio", "PUT", { enabled: true, agent: AGENT, previewSignIn: true });
    const guest = await openLink();
    const links = await api<StudioGuestLinkList>(`${PREVIEW}/studio/links`);
    await api(`${PREVIEW}/studio/links/${links.body.links[0]?.id}`, "DELETE");
    context.advance(31_000);

    const gone = await call(context.app, "/api/proxy-pages/studio-signin", {
      headers: {
        "x-forwarded-host": HOST,
        "x-forwarded-uri": "/",
        "x-forwarded-method": "GET",
        accept: "text/html",
        cookie: guest,
      },
    });

    expect(gone.status).toBe(403);
    expect(String(gone.body)).toContain("Lien expiré");
    expect(gone.setCookie).toMatch(/opsifier_studio_guest=;.*Max-Age=0/);
  });
});

describe("two Studio previews on one host", () => {
  it("open nothing there: the host alone can't tell them apart", async () => {
    await api(`${PREVIEW}/domains`, "POST", { host: "shared.example.com", path: "/a" });
    await api(`${OTHER}/domains`, "POST", { host: "shared.example.com", path: "/b" });
    const guest = await openLink();

    expect((await onPreview("/remarks", { cookie: guest, host: "shared.example.com" })).status).toBe(404);
  });
});

describe("a project shared with a designer", () => {
  it("lets them make links and handle remarks; anyone else finds nothing", async () => {
    const designer = await signInMember(context.app, cookie, "designer@example.com", []);
    const stranger = await signInMember(context.app, cookie, "stranger@example.com", []);
    const users = await api<{ users: { id: string; email: string }[] }>("/users");
    const id = users.body.users.find((user) => user.email === "designer@example.com")?.id;
    await api(`${PREVIEW}/studio/members`, "PUT", { userIds: [id] });

    const made = await api<CreatedStudioGuestLink>(
      `${PREVIEW}/studio/links`,
      "POST",
      { label: "Karim" },
      designer,
    );
    expect(made.status).toBe(201);
    expect(made.body.createdBy).toBe("designer@example.com");
    expect((await api(`${PREVIEW}/studio/remarks`, "GET", undefined, designer)).status).toBe(200);

    for (const [path, method] of [
      [`${PREVIEW}/studio/links`, "GET"],
      [`${PREVIEW}/studio/links`, "POST"],
      [`${PREVIEW}/studio/remarks`, "GET"],
      [`${OTHER}/studio/remarks`, "GET"],
    ] as const) {
      const as = path.startsWith(OTHER) ? designer : stranger;
      expect((await api(path, method, method === "POST" ? { label: "x" } : undefined, as)).status).toBe(404);
    }
  });
});

describe("a preview behind the panel's sign-in", () => {
  const CHECK = "/api/proxy-pages/studio-signin";
  const askedByTraefik = (as?: string) =>
    call(context.app, CHECK, {
      headers: {
        "x-forwarded-host": HOST,
        "x-forwarded-uri": "/",
        "x-forwarded-method": "GET",
        accept: "text/html",
        ...(as === undefined ? {} : { cookie: as }),
      },
    });

  it("lets a link's guest in until the link is taken back", async () => {
    const saved = await api<StudioSettings>("/settings/studio", "PUT", {
      enabled: true,
      agent: AGENT,
      previewSignIn: true,
    });
    expect(saved.body.previewSignIn).toBe(true);
    expect(ROUTES()).toContain("forwardAuth");
    // The panel's own pages on the preview stay outside the sign-in: a link must open without an account.
    expect(ROUTES()).toContain("PathPrefix(`/__opsifier/studio/`)");
    const guest = await openLink();

    expect((await askedByTraefik(guest)).status).toBe(200);

    const links = await api<StudioGuestLinkList>(`${PREVIEW}/studio/links`);
    await api(`${PREVIEW}/studio/links/${links.body.links[0]?.id}`, "DELETE");
    context.advance(31_000);
    const gone = await askedByTraefik(guest);
    expect(gone.status).toBe(403);
    expect(String(gone.body)).toContain("Lien expiré");
  });
});
