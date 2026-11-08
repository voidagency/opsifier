import "./browser-stubs";
import "../i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { vi } from "vitest";
import { createAppRouter } from "../app/router";
import { realtime } from "../lib/realtime";
import { Toaster, TooltipProvider } from "../ui";

type Handler = (body: unknown, url: URL) => unknown;

export interface FakeRoute {
  /** `"GET /projects"`: method and path relative to `/api/v1`. Matched exactly, query strings aside. */
  [route: string]: unknown;
}

export const SIGNED_IN = {
  status: "signed-in",
  user: { id: "u1", email: "admin@example.com", role: "admin", twoFactorEnabled: false },
};

/** Marks a response with a status other than 200. */
export function withStatus(status: number, body: unknown) {
  return { __status: status, body };
}

export interface FakeServer {
  calls: Array<{ method: string; path: string; body: unknown }>;
  /** Replaces or adds routes while the app is running. */
  set(routes: FakeRoute): void;
}

export function installFakeServer(routes: FakeRoute): FakeServer {
  const table = new Map<string, unknown>(Object.entries({ "GET /auth/session": SIGNED_IN, ...routes }));
  const calls: FakeServer["calls"] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      const path = url.pathname.replace(/^\/api\/v1/, "");
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });

      const defaults: Record<string, unknown> = {
        "GET /system/info": { version: "0.0.0-test", serverIp: "203.0.113.10" },
        "GET /actions": { items: [], nextCursor: null },
      };
      const key = `${method} ${path}`;
      const route = table.has(key) ? table.get(key) : defaults[key];
      if (route === undefined) {
        return new Response(JSON.stringify({ error: { code: "not_found", message: "Not found." } }), {
          status: 404,
        });
      }
      const value = typeof route === "function" ? (route as Handler)(body, url) : route;
      const { __status: status, body: payload } = (value as { __status?: number; body?: unknown }) ?? {};
      if (typeof status === "number") {
        return new Response(JSON.stringify(payload), { status });
      }
      return new Response(JSON.stringify(value), { status: 200 });
    }),
  );

  return {
    calls,
    set(next) {
      for (const [key, value] of Object.entries(next)) {
        table.set(key, value);
      }
    },
  };
}

type TopicHandler = (payload: unknown) => void;

/** Renders the real router at a URL. The WebSocket is replaced so tests can push events themselves. */
export function renderApp(path: string) {
  const handlers = new Map<string, Set<TopicHandler>>();
  vi.spyOn(realtime, "connect").mockImplementation(() => {});
  vi.spyOn(realtime, "disconnect").mockImplementation(() => {});
  vi.spyOn(realtime, "subscribe").mockImplementation((topic: string, handler: unknown) => {
    const set = handlers.get(topic) ?? new Set();
    set.add(handler as TopicHandler);
    handlers.set(topic, set);
    return () => set.delete(handler as TopicHandler);
  });

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));

  const view = render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>,
  );

  return {
    ...view,
    router,
    queryClient,
    /** Delivers an event to everyone subscribed to a topic, as the server would. */
    emit: (topic: string, payload: unknown) =>
      act(() => {
        for (const handler of handlers.get(topic) ?? []) {
          handler(payload);
        }
      }),
    location: () => router.state.location.pathname,
  };
}

export function resetApp(): void {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
}

/** Waits until the app has settled on a URL, for assertions about where a flow ended up. */
export async function expectLocation(app: ReturnType<typeof renderApp>, pathname: string): Promise<void> {
  await waitFor(() => {
    if (app.location() !== pathname) {
      throw new Error(`Still at ${app.location()}`);
    }
  });
}

export const findText = (text: string | RegExp) => screen.findByText(text);
