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
import { studioRemarkScreenshots } from "../../core/db/schema";
import {
  apiErrorOf,
  authPost,
  type CallResult,
  call,
  createTestContext,
  credentialHeaders,
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

describe("a screenshot with a remark", () => {
  // Two pixels by two, as an image library writes them.
  const JPEG = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDVooor8wP1Y//Z",
    "base64",
  );
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8WSzGwMDAxAAGABMlAYYBfDl/AAAAAElFTkSuQmCC",
    "base64",
  );
  const WEBP = Buffer.from(
    "UklGRjwAAABXRUJQVlA4IDAAAAAwAgCdASoCAAIAAUAmJaACdLoB+AH4AAShAAD+4ka/9rQHBqv9Oz/7aGdUJf7QAAA=",
    "base64",
  );
  const dataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString("base64")}`;
  type Written = { remark: StudioPreviewRemarks["remarks"][number] };
  const post = (guest: string, screenshot: unknown, text = "Le bouton est caché") =>
    onPreview<Written>("/remarks", {
      method: "POST",
      body: { ...remark(text), screenshot },
      cookie: guest,
      origin: `https://${HOST}`,
    });
  /** The image, as the Studio fetches it: raw bytes, which the harness would read as text. */
  const fetchShot = async (path: string, as = cookie) => {
    const response = await context.app.request(`/api/v1${path}`, { headers: credentialHeaders(as) });
    return { response, bytes: Buffer.from(await response.arrayBuffer()) };
  };
  const stored = () => context.deps.db.select().from(studioRemarkScreenshots).all().length;

  it("is kept apart from its remark, flagged in the lists, and sent as the image it is", async () => {
    const guest = await openLink();
    const shot = await post(guest, dataUrl("image/jpeg", JPEG));
    const plain = await post(guest, null, "Sans capture");
    expect(shot.status).toBe(201);
    expect(shot.body.remark.screenshot).toBe(true);
    expect(plain.body.remark.screenshot).toBe(false);

    const seen = await onPreview<StudioPreviewRemarks>("/remarks", { cookie: guest });
    expect(seen.body.remarks.map((one) => [one.number, one.screenshot])).toEqual([
      [1, true],
      [2, false],
    ]);
    // Neither list carries the image itself.
    expect(JSON.stringify(seen.body)).not.toContain(JPEG.toString("base64"));
    const listed = await api<StudioRemarkList>(`${PREVIEW}/studio/remarks`);
    expect(listed.body.remarks.map((one) => [one.number, one.screenshot])).toEqual([
      [2, false],
      [1, true],
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(JPEG.toString("base64"));

    const { response, bytes } = await fetchShot(
      `${PREVIEW}/studio/remarks/${shot.body.remark.id}/screenshot`,
    );
    expect(response.status).toBe(200);
    expect(bytes.equals(JPEG)).toBe(true);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="remark-1.jpeg"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const none = await fetchShot(`${PREVIEW}/studio/remarks/${plain.body.remark.id}/screenshot`);
    expect(none.response.status).toBe(404);

    const handed = await api<StudioRemark>(`${PREVIEW}/studio/remarks/${shot.body.remark.id}`, "PATCH", {
      status: "in_progress",
    });
    expect(handed.body.screenshot).toBe(true);
  });

  it("is a JPEG, a PNG or a WebP image, as its first bytes say, and nothing else", async () => {
    const guest = await openLink();

    for (const [type, bytes] of [
      ["image/png", PNG],
      ["image/webp", WEBP],
    ] as const) {
      const sent = await post(guest, dataUrl(type, bytes));
      expect(sent.status).toBe(201);
      const { response } = await fetchShot(`${PREVIEW}/studio/remarks/${sent.body.remark.id}/screenshot`);
      expect(response.headers.get("content-type")).toBe(type);
    }
    const refused = [
      dataUrl(
        "image/svg+xml",
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'),
      ),
      // A JPEG that says it is a PNG, and a page that says it is a JPEG.
      dataUrl("image/png", JPEG),
      dataUrl("image/jpeg", Buffer.from("<html><script>alert(1)</script></html>")),
      dataUrl("image/gif", Buffer.from("GIF89a")),
      // The right first bytes, and nothing an image is made of after them.
      dataUrl("image/jpeg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(96, 7)])),
      dataUrl("image/jpeg", JPEG.subarray(0, JPEG.length - 2)),
      dataUrl("image/png", Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(64, 3)])),
      dataUrl("image/webp", Buffer.concat([WEBP, Buffer.alloc(4)])),
      "data:image/jpeg;base64,not base64!",
      "https://evil.example.com/shot.jpg",
      42,
    ];
    for (const screenshot of refused) {
      const sent = await post(guest, screenshot);
      expect(sent.status).toBe(400);
      expect(apiErrorOf(sent).fields).toHaveProperty("screenshot");
    }
    // At most a data URL of 240,000 characters, and nothing past the size of a request.
    const long = `data:image/jpeg;base64,${Buffer.concat([JPEG, Buffer.alloc(180_000)]).toString("base64")}`;
    expect(long.length).toBeGreaterThan(240_000);
    expect((await post(guest, long)).status).toBe(400);
    expect((await post(guest, `${long}${"A".repeat(100_000)}`)).status).toBe(413);

    expect(stored()).toBe(2);
    const listed = await api<StudioRemarkList>(`${PREVIEW}/studio/remarks`);
    expect(listed.body.remarks).toHaveLength(2);
  });

  it("goes with its remark, whoever deletes it", async () => {
    const guest = await openLink();
    const write = async () => (await post(guest, dataUrl("image/jpeg", JPEG))).body.remark.id;
    const takenBack = await write();
    const deleted = await write();
    await write();
    await write();
    expect(stored()).toBe(4);

    await onPreview(`/remarks/${takenBack}`, { method: "DELETE", cookie: guest, origin: `https://${HOST}` });
    expect(stored()).toBe(3);
    await api(`${PREVIEW}/studio/remarks/${deleted}`, "DELETE");
    expect(stored()).toBe(2);
    const links = await api<StudioGuestLinkList>(`${PREVIEW}/studio/links`);
    await api(`${PREVIEW}/studio/links/${links.body.links[0]?.id}?remarks=delete`, "DELETE");
    expect(stored()).toBe(0);
  });

  it("is shown to whoever reaches the project only", async () => {
    const guest = await openLink();
    const id = (await post(guest, dataUrl("image/jpeg", JPEG))).body.remark.id;
    const stranger = await signInMember(context.app, cookie, "stranger@example.com", []);

    expect((await fetchShot(`${PREVIEW}/studio/remarks/${id}/screenshot`, stranger)).response.status).toBe(
      404,
    );
    expect((await fetchShot(`${OTHER}/studio/remarks/${id}/screenshot`)).response.status).toBe(404);
    expect((await fetchShot(`${PREVIEW}/studio/remarks/${id}/screenshot`, "")).response.status).toBe(401);
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
