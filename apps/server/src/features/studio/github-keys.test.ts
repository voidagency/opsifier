import type { StudioGithubKey, StudioGithubKeyCheck, StudioGithubKeyList } from "@opsifier/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiErrorOf,
  call,
  createTestContext,
  setupAdmin,
  signInMember,
  TEST_ORIGIN,
  type TestContext,
} from "../../testing/harness";
import { getSetting, putSetting } from "../system/repo";
import { githubKeyFor, lastPageOf, parseTokenExpiry } from "./github-keys";

const KEYS = "/api/v1/settings/studio/github-keys";
const TOKEN = "github_pat_11AAAAAAA0voidagency0token0kept0sealed";
const OTHER = "github_pat_22BBBBBBB0a0new0token0for0voidagency";

let context: TestContext;
let cookie: string;

const api = <T = unknown>(path: string, method = "GET", body?: unknown, as = cookie) =>
  call<T>(context.app, path, { method, body, cookie: as, origin: TEST_ORIGIN });

beforeEach(async () => {
  context = await createTestContext();
  cookie = await setupAdmin(context.app);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await context.close();
});

describe("the Studio's GitHub keys", () => {
  it("keeps one token per owner, sealed, and never sends it back", async () => {
    const added = await api<StudioGithubKey>(KEYS, "POST", { owner: "voidagency", token: TOKEN });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ owner: "voidagency", login: null, expiresAt: null });
    expect(JSON.stringify(added.body)).not.toContain(TOKEN);
    expect(JSON.stringify(getSetting(context.deps.db, "studio_github_keys"))).not.toContain(TOKEN);

    const again = await api(KEYS, "POST", { owner: "VoidAgency", token: OTHER });
    expect(again.status).toBe(409);
    expect(apiErrorOf(again).code).toBe("studio_github_key_exists");

    const listed = await api<StudioGithubKeyList>(KEYS);
    expect(listed.body.keys.map((key) => key.owner)).toEqual(["voidagency"]);
    expect(JSON.stringify(listed.body)).not.toContain(TOKEN);
  });

  it("is chosen by the repository's owner, whatever its case", async () => {
    await api(KEYS, "POST", { owner: "voidagency", token: TOKEN });

    expect(githubKeyFor(context.deps, "VoidAgency/mcp-checkmate")).toBe(TOKEN);
    expect(githubKeyFor(context.deps, "mehdinajeddine/cd-studio")).toBeNull();
  });

  it("takes a new token, and goes", async () => {
    const { body: key } = await api<StudioGithubKey>(KEYS, "POST", { owner: "voidagency", token: TOKEN });

    expect((await api(`${KEYS}/${key.id}`, "PUT", { token: OTHER })).status).toBe(200);
    expect(githubKeyFor(context.deps, "voidagency/mcp-checkmate")).toBe(OTHER);

    expect((await api(`${KEYS}/${key.id}`, "DELETE")).status).toBe(200);
    expect(githubKeyFor(context.deps, "voidagency/mcp-checkmate")).toBeNull();
    expect((await api(`${KEYS}/${key.id}`, "DELETE")).status).toBe(404);
  });

  it("refuses what is not an owner's name or a token", async () => {
    expect((await api(KEYS, "POST", { owner: "void agency", token: TOKEN })).status).toBe(400);
    expect((await api(KEYS, "POST", { owner: "voidagency", token: "short" })).status).toBe(400);
    expect((await api(KEYS, "POST", { owner: "voidagency", token: `${TOKEN} x` })).status).toBe(400);
  });

  it("is for an administrator at a browser", async () => {
    const member = await signInMember(context.app, cookie, "designer@example.com", []);
    expect((await api(KEYS, "GET", undefined, member)).status).toBe(403);
    expect((await api(KEYS, "POST", { owner: "voidagency", token: TOKEN }, member)).status).toBe(403);
  });

  it("says what GitHub thinks of a token, and remembers it", async () => {
    const { body: key } = await api<StudioGithubKey>(KEYS, "POST", { owner: "voidagency", token: TOKEN });
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).endsWith("/user")
        ? new Response(JSON.stringify({ login: "mehdinajeddine" }), {
            status: 200,
            headers: { "github-authentication-token-expiration": "2027-02-14 10:00:00 UTC" },
          })
        : new Response(JSON.stringify([{ name: "mcp-checkmate" }]), {
            status: 200,
            headers: {
              link: '<https://api.github.com/organizations/1/repos?type=private&per_page=1&page=2>; rel="next", <https://api.github.com/organizations/1/repos?type=private&per_page=1&page=137>; rel="last"',
            },
          }),
    );

    const checked = await api<StudioGithubKeyCheck>(`${KEYS}/${key.id}/check`, "POST");

    expect(checked.body).toEqual({
      ok: true,
      login: "mehdinajeddine",
      expiresAt: "2027-02-14T10:00:00.000Z",
      repositories: 137,
      message: null,
    });
    expect(String(fetched.mock.calls[1]?.[0])).toContain("/orgs/voidagency/repos?type=private&per_page=1");
    const sent = new Headers(fetched.mock.calls[0]?.[1]?.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${TOKEN}`);
    const listed = await api<StudioGithubKeyList>(KEYS);
    expect(listed.body.keys[0]).toMatchObject({
      valid: true,
      login: "mehdinajeddine",
      expiresAt: "2027-02-14T10:00:00.000Z",
    });
  });

  it("keeps what a check found off a token replaced meanwhile", async () => {
    const { body: key } = await api<StudioGithubKey>(KEYS, "POST", { owner: "voidagency", token: TOKEN });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/user")) {
        // An administrator gives the key a new token while GitHub answers about the old one.
        await api(`${KEYS}/${key.id}`, "PUT", { token: OTHER });
        return new Response(JSON.stringify({ login: "someone-else" }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });

    await api(`${KEYS}/${key.id}/check`, "POST");

    const listed = await api<StudioGithubKeyList>(KEYS);
    expect(listed.body.keys[0]).toMatchObject({ valid: null, login: null, checkedAt: null });
  });

  it("says GitHub refused a token", async () => {
    const { body: key } = await api<StudioGithubKey>(KEYS, "POST", { owner: "voidagency", token: TOKEN });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));

    const checked = await api<StudioGithubKeyCheck>(`${KEYS}/${key.id}/check`, "POST");

    expect(checked.body.ok).toBe(false);
    expect(checked.body.message).toContain("refused");
    expect((await api<StudioGithubKeyList>(KEYS)).body.keys[0]).toMatchObject({
      valid: false,
      expiresAt: null,
    });
  });

  it("is not hidden or lost by an entry it cannot read", async () => {
    await api(KEYS, "POST", { owner: "voidagency", token: TOKEN });
    const stored = getSetting(context.deps.db, "studio_github_keys") as unknown[];
    putSetting(context.deps.db, "studio_github_keys", [...stored, { broken: true }], new Date());

    expect(githubKeyFor(context.deps, "voidagency/site")).toBe(TOKEN);
    expect((await api(KEYS, "POST", { owner: "mehdinajeddine", token: OTHER })).status).toBe(201);
    const after = getSetting(context.deps.db, "studio_github_keys") as unknown[];
    expect(after).toHaveLength(3);
    expect(after).toContainEqual({ broken: true });
  });

  it("changes nothing when what is stored is not a list of keys", async () => {
    putSetting(context.deps.db, "studio_github_keys", { not: "a list" }, new Date());

    const refused = await api(KEYS, "POST", { owner: "voidagency", token: TOKEN });

    expect(refused.status).toBe(409);
    expect(apiErrorOf(refused).code).toBe("studio_github_keys_unreadable");
    expect(getSetting(context.deps.db, "studio_github_keys")).toEqual({ not: "a list" });
  });
});

describe("GitHub's last page, one repository a page", () => {
  it("is how many there are", () => {
    expect(
      lastPageOf(
        '<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?per_page=1&page=12>; rel="last"',
      ),
    ).toBe(12);
    expect(lastPageOf(null)).toBeNull();
    expect(lastPageOf('<https://api.github.com/user/repos?page=2>; rel="next"')).toBeNull();
  });
});

describe("a token's expiry, as GitHub writes it", () => {
  it("is read in UTC or with an offset, and nothing else", () => {
    expect(parseTokenExpiry("2027-02-14 10:00:00 UTC")).toBe("2027-02-14T10:00:00.000Z");
    expect(parseTokenExpiry("2027-02-14 10:00:00 +0100")).toBe("2027-02-14T09:00:00.000Z");
    expect(parseTokenExpiry(null)).toBeNull();
    expect(parseTokenExpiry("soon")).toBeNull();
  });
});
