import { afterEach, describe, expect, it, vi } from "vitest";
import { authApi } from "../features/auth/session";
import { backupDownloadUrl } from "../features/backups/api";
import { api } from "./api";
import { RealtimeClient } from "./realtime";
import { keepSessionBinding, panelProtocols, sessionBinding, withBinding } from "./session-binding";

const SECRET = "s".repeat(43);

function stubFetch(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, string> {
  const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
  return init.headers as Record<string, string>;
}

const signedIn = {
  status: "signed-in",
  user: { id: "u1", email: "ada@example.com", role: "admin", twoFactorEnabled: false, hostAdmin: true },
  twoFactorSetupRequired: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  keepSessionBinding(undefined);
});

describe("the second secret of a session opened over plain HTTP", () => {
  it("goes with every call to the panel once a sign-in returned it, and with none before", async () => {
    const fetchMock = stubFetch({});

    await api.get("/projects");
    keepSessionBinding(SECRET);
    await api.get("/projects");

    expect(sentHeaders(fetchMock, 0)).not.toHaveProperty("X-Opsifier-Binding");
    expect(sentHeaders(fetchMock, 1)).toMatchObject({ "X-Opsifier-Binding": SECRET });
  });

  it("is kept from the sign-in answer and left out of the session the app caches", async () => {
    stubFetch({ ...signedIn, binding: SECRET });

    const state = await authApi.login({
      email: "ada@example.com",
      password: "a password",
      rememberMe: false,
    });

    expect(sessionBinding()).toBe(SECRET);
    expect(state).not.toHaveProperty("binding");
  });

  it("is forgotten by a sign-in that returns none, over HTTPS, and by signing out", async () => {
    keepSessionBinding(SECRET);
    stubFetch(signedIn);
    await authApi.login({ email: "ada@example.com", password: "a password", rememberMe: false });
    expect(sessionBinding()).toBeNull();

    keepSessionBinding(SECRET);
    const fetchMock = stubFetch({ status: "signed-out" });
    await authApi.logout();
    expect(sentHeaders(fetchMock)).toMatchObject({ "X-Opsifier-Binding": SECRET });
    expect(sessionBinding()).toBeNull();
  });

  it("is named in the address of what the browser opens by itself", () => {
    expect(withBinding("/api/v1/x")).toBe("/api/v1/x");
    keepSessionBinding(SECRET);
    expect(withBinding("/api/v1/x")).toBe(`/api/v1/x?binding=${SECRET}`);
    expect(withBinding("/api/v1/x?host=a")).toBe(`/api/v1/x?host=a&binding=${SECRET}`);
    expect(backupDownloadUrl("shop", "db", "b1")).toMatch(new RegExp(`/download\\?binding=${SECRET}$`));
  });

  it("goes as a subprotocol of the panel's WebSockets, after the panel's own", () => {
    const sockets: Array<{ url: string; protocols: unknown }> = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor(url: string, protocols?: unknown) {
          sockets.push({ url, protocols });
        }
        readonly readyState = 0;
        addEventListener() {}
        close() {}
      },
    );
    expect(panelProtocols()).toEqual(["opsifier"]);
    keepSessionBinding(SECRET);

    const client = new RealtimeClient({ url: "ws://panel.invalid/api/v1/ws" });
    client.connect();
    client.disconnect();

    expect(sockets[0]?.protocols).toEqual(["opsifier", `opsifier-binding.${SECRET}`]);
  });
});
