// @vitest-environment jsdom
import "../../testing/browser-stubs";
import type { ProjectSummary, ServiceSummary, TemplateInstall } from "@opsifier/contract";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPaletteOpen } from "../../app/commands";
import { installFakeServer, renderApp, resetApp, SIGNED_IN } from "../../testing/appHarness";
import { isPrivateIp, sslipBase } from "./address";
import { onlySample, stepStates } from "./GetStarted";
import { resetProgressCache } from "./progress";
import { stageOf } from "./sample";
import { placeCard } from "./Tour";
import { endTour } from "./tours";

const USER_KEY = `opsifier.onboarding.${SIGNED_IN.user.id}`;

beforeEach(() => {
  resetProgressCache();
  endTour();
});

afterEach(() => {
  endTour();
  // The palette's state outlives a test: one left open would keep every tour from offering itself.
  act(() => setPaletteOpen(false));
  resetApp();
  resetProgressCache();
});

const service = (overrides: Partial<ServiceSummary> = {}): ServiceSummary => ({
  projectName: "apps",
  name: "it-tools",
  type: "app",
  status: "undeployed",
  replicas: { running: 0, desired: 1 },
  activeAction: null,
  runtimeUncertain: null,
  wake: [],
  lastDeployedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const install = (svc: ServiceSummary): TemplateInstall => ({
  id: "inst1",
  projectName: "apps",
  templateId: "it-tools",
  templateVersion: "1.0.0",
  templateName: "IT Tools",
  category: "development",
  custom: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  instructions: null,
  components: [
    { role: "app", kind: "app", service: svc, url: "https://apps-it-tools.34.240.101.95.sslip.io/" },
  ],
  secrets: [],
});

const purpose = (chosen: "development" | "production" | null) => ({
  purpose: chosen,
  protection: chosen !== "production",
  domains: [],
  protectedCount: 0,
  totalCount: 0,
  problems: [],
  confirmation: "PUBLIC",
});

/** An Action as the API answers it. */
const entry = (overrides: Record<string, unknown> = {}) => ({
  id: "d1",
  type: "template.deploy",
  title: "Deploy IT Tools",
  status: "running",
  phase: null,
  projectName: "apps",
  serviceName: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  error: null,
  hasLog: false,
  actorEmail: null,
  ...overrides,
});

/** A fresh panel: nothing deployed, the server in development, a public IP. */
function freshPanel(routes: Record<string, unknown> = {}) {
  return installFakeServer({
    "GET /projects": { projects: [] },
    "GET /server-purpose": purpose("development"),
    "GET /server-purpose/users": {
      users: [{ id: "g1", username: "opsifier", createdAt: "2026-01-01T00:00:00.000Z" }],
    },
    "GET /system/info": { version: "0.0.0-test", serverIp: "34.240.101.95", simulated: false },
    "GET /server/service-domain": { defaultDomain: "*.34.240.101.95.sslip.io", customDomain: null },
    ...routes,
  });
}

const guide = () => screen.findByRole("region", { name: "Your server is ready" });

/** The tours have been seen, so that none offers itself over what a test looks at. */
const quietTours = () =>
  localStorage.setItem(
    USER_KEY,
    JSON.stringify({ tours: { panel: "dismissed", service: "dismissed" }, guide: "auto" }),
  );

/** Answers the first-use question later, as an owner who wants to look around first. */
async function decideLater() {
  fireEvent.click(await screen.findByRole("button", { name: "Decide later" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "What is this server for?" })).toBeNull());
}

describe("the Get started guide", () => {
  it("shows an administrator of a fresh panel where apps will answer, and three ways to start", async () => {
    quietTours();
    freshPanel();
    renderApp("/");

    const section = await guide();
    expect(within(section).getByText("https://apps-it-tools.34.240.101.95.sslip.io")).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Deploy IT Tools" })).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Browse the apps" })).toBeTruthy();
    expect(within(section).getByRole("button", { name: "Add a service" })).toBeTruthy();
    expect(within(section).queryByRole("button", { name: "Set the server's IP" })).toBeNull();
  });

  it("is not shown to a member, nor once something else than the sample is deployed", async () => {
    installFakeServer({
      "GET /auth/session": { ...SIGNED_IN, user: { ...SIGNED_IN.user, role: "member" } },
      "GET /projects": { projects: [] },
    });
    const view = renderApp("/");
    await screen.findByRole("heading", { name: "Overview" });
    expect(screen.queryByRole("region", { name: "Your server is ready" })).toBeNull();
    view.unmount();
    resetApp();

    const shop: ProjectSummary = {
      name: "shop",
      createdAt: "2026-01-01T00:00:00.000Z",
      services: [service({ projectName: "shop", name: "web", status: "running" })],
    };
    quietTours();
    freshPanel({ "GET /projects": { projects: [shop] } });
    renderApp("/");
    await screen.findByRole("link", { name: "shop" });
    expect(screen.queryByRole("region", { name: "Your server is ready" })).toBeNull();
  });

  it("can be hidden, for good, and brought back from the account menu", async () => {
    quietTours();
    freshPanel();
    renderApp("/");

    fireEvent.click(within(await guide()).getByRole("button", { name: "Hide this guide" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Your server is ready" })).toBeNull());
    expect(JSON.parse(localStorage.getItem(USER_KEY) ?? "{}").guide).toBe("hidden");
    expect(
      await screen.findByText("The guide is in your account menu whenever you need it again."),
    ).toBeTruthy();

    const trigger = screen.getByRole("button", { name: "Account menu" });
    act(() => trigger.focus());
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Get started guide" }));
    expect(await guide()).toBeTruthy();
  });

  it("says when the server's IP is private, and sets the one people reach it on", async () => {
    quietTours();
    const server = freshPanel({
      "GET /system/info": { version: "0.0.0-test", serverIp: "172.31.5.9", simulated: false },
      "GET /server/service-domain": { defaultDomain: "*.172.31.5.9.sslip.io", customDomain: null },
      "PUT /server/panel/ip": entry({
        id: "a1",
        type: "server.set-ip",
        status: "succeeded",
        title: "Server address is now 34.240.101.95",
        projectName: null,
      }),
    });
    renderApp("/");

    const section = await guide();
    expect(within(section).getByText(/172\.31\.5\.9 is a private address/)).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "Set the server's IP" }));
    const dialog = await screen.findByRole("dialog", { name: "The server's IP" });
    const field = within(dialog).getByLabelText("IP address");
    fireEvent.change(field, { target: { value: " 34.240.101.95 " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Use this IP" }));

    await waitFor(() =>
      expect(server.calls.some((call) => call.method === "PUT" && call.path === "/server/panel/ip")).toBe(
        true,
      ),
    );
    expect(server.calls.find((call) => call.path === "/server/panel/ip")?.body).toEqual({
      ip: "34.240.101.95",
    });
  });
});

describe("the sample app", () => {
  it("makes the project, installs IT Tools, deploys it and follows it to its address", async () => {
    let installs: TemplateInstall[] = [];
    let projects: ProjectSummary[] = [];
    const server = freshPanel({
      "GET /server-purpose": purpose(null),
      "GET /projects": () => ({ projects }),
      "POST /projects": (body: unknown) => {
        projects = [{ name: "apps", createdAt: "2026-01-01T00:00:00.000Z", services: [] }];
        return { ...(body as object), createdAt: "2026-01-01T00:00:00.000Z", services: [] };
      },
      "GET /projects/apps/templates": () => ({ installs }),
      "POST /projects/apps/templates": () => {
        installs = [install(service())];
        return installs[0];
      },
      "POST /projects/apps/templates/inst1/deploy": () => {
        installs = [
          install(service({ status: "starting", activeAction: { id: "d1", type: "template.deploy" } })),
        ];
        return entry();
      },
    });
    quietTours();
    renderApp("/");
    await decideLater();

    fireEvent.click(within(await guide()).getByRole("button", { name: "Deploy IT Tools" }));
    expect(await screen.findByText(/Deploying: the image is downloaded once/)).toBeTruthy();
    expect(server.calls.find((call) => call.method === "POST" && call.path === "/projects")?.body).toEqual({
      name: "apps",
    });
    expect(
      server.calls.find((call) => call.method === "POST" && call.path === "/projects/apps/templates")?.body,
    ).toEqual({
      source: { type: "catalogue", id: "it-tools" },
      services: { app: { name: "it-tools" } },
      params: {},
    });
    // The server's purpose is not chosen yet: every site stays locked until it is.
    expect(screen.getByText(/Choose what this server is for first/)).toBeTruthy();

    installs = [
      install(service({ status: "running", replicas: { running: 1, desired: 1 }, wake: ["succeeded"] })),
    ];
    const open = await screen.findByRole("link", { name: "Open IT Tools" }, { timeout: 5000 });
    expect(open.getAttribute("href")).toBe("https://apps-it-tools.34.240.101.95.sslip.io/");
    // Its sites ask for the server's password: a click goes through the panel, which lets the browser in.
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    fireEvent.click(open);
    expect(opened).toHaveBeenCalledWith(
      `/api/v1/server-purpose/open?url=${encodeURIComponent("https://apps-it-tools.34.240.101.95.sslip.io/")}`,
      "_blank",
      "noopener,noreferrer",
    );
    opened.mockRestore();
    expect(screen.getByRole("link", { name: "See it in the panel" }).getAttribute("href")).toBe(
      "/projects/apps/app/it-tools",
    );
  });

  it("takes up an install made earlier instead of making a second one", async () => {
    const earlier = install(service());
    const server = freshPanel({
      "GET /projects": {
        projects: [
          { name: "apps", createdAt: "2026-01-01T00:00:00.000Z", services: [earlier.components[0]?.service] },
        ],
      },
      "GET /projects/apps/templates": { installs: [earlier] },
      "POST /projects/apps/templates/inst1/deploy": entry(),
    });
    localStorage.setItem(USER_KEY, JSON.stringify({ tours: { panel: "dismissed" }, guide: "auto" }));
    renderApp("/");

    fireEvent.click(within(await guide()).getByRole("button", { name: "Deploy IT Tools" }));
    await waitFor(() =>
      expect(server.calls.some((call) => call.path === "/projects/apps/templates/inst1/deploy")).toBe(true),
    );
    expect(
      server.calls.some((call) => call.method === "POST" && call.path === "/projects/apps/templates"),
    ).toBe(false);
    expect(server.calls.some((call) => call.method === "POST" && call.path === "/projects")).toBe(false);
  });
});

/** Every element a tour points at gets a size, as a browser would give it: jsdom draws nothing. */
function giveTargetsASize() {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.dataset.tour === undefined
      ? original.call(this)
      : ({
          x: 100,
          y: 100,
          left: 100,
          top: 100,
          right: 260,
          bottom: 132,
          width: 160,
          height: 32,
          toJSON: () => ({}),
        } as DOMRect);
  });
}

describe("the panel tour", () => {
  it("offers itself once the purpose is chosen, moves with the keys, and is remembered", async () => {
    giveTargetsASize();
    freshPanel({ "GET /server-purpose": purpose("development") });
    renderApp("/");

    const card = await screen.findByRole("dialog", { name: "Welcome to Opsifier" }, { timeout: 4000 });
    expect(within(card).getByText("1 / 8")).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Next"));

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByRole("dialog", { name: "Start here" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(await screen.findByRole("dialog", { name: "Welcome to Opsifier" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    const domains = await screen.findByRole("dialog", { name: "Projects" });
    expect(within(domains).getByRole("button", { name: "Back" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Projects" })).toBeNull());
    expect(JSON.parse(localStorage.getItem(USER_KEY) ?? "{}").tours).toEqual({ panel: "dismissed" });
  });

  it("names the base new services get, and ends with Done", async () => {
    giveTargetsASize();
    freshPanel({ "GET /server-purpose": purpose("production") });
    renderApp("/");

    await screen.findByRole("dialog", { name: "Welcome to Opsifier" }, { timeout: 4000 });
    for (let stop = 1; stop < 3; stop += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    }
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    const domains = await screen.findByRole("dialog", { name: "Every address" });
    expect(within(domains).getByText(/under 34\.240\.101\.95\.sslip\.io with HTTPS/)).toBeTruthy();
    for (let stop = 4; stop < 8; stop += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    }
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(JSON.parse(localStorage.getItem(USER_KEY) ?? "{}").tours).toEqual({ panel: "done" });
  });

  it("is not offered again once seen, nor before the purpose is chosen", async () => {
    giveTargetsASize();
    localStorage.setItem(USER_KEY, JSON.stringify({ tours: { panel: "done" }, guide: "auto" }));
    freshPanel({ "GET /server-purpose": purpose("development") });
    const view = renderApp("/");
    await guide();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(screen.queryByRole("dialog", { name: "Welcome to Opsifier" })).toBeNull();
    view.unmount();
    resetApp();
    resetProgressCache();

    giveTargetsASize();
    freshPanel({ "GET /server-purpose": purpose(null) });
    renderApp("/");
    await decideLater();
    await guide();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(screen.queryByRole("dialog", { name: "Welcome to Opsifier" })).toBeNull();
    // The guide still starts it.
    fireEvent.click(within(await guide()).getByRole("button", { name: "Take the tour" }));
    expect(await screen.findByRole("dialog", { name: "Welcome to Opsifier" })).toBeTruthy();
  });

  it("makes way for the command palette, and lets the browser's own shortcuts be", async () => {
    giveTargetsASize();
    freshPanel();
    renderApp("/");

    await screen.findByRole("dialog", { name: "Welcome to Opsifier" }, { timeout: 4000 });
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    expect(screen.getByRole("dialog", { name: "Welcome to Opsifier" })).toBeTruthy();

    const next = screen.getByRole("button", { name: "Next" });
    fireEvent.keyDown(next, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Welcome to Opsifier" })).toBeNull();
    expect(JSON.parse(localStorage.getItem(USER_KEY) ?? "{}").tours).toEqual({ panel: "dismissed" });
  });

  it("counts as left when the page changes under it", async () => {
    giveTargetsASize();
    freshPanel();
    const app = renderApp("/");

    await screen.findByRole("dialog", { name: "Welcome to Opsifier" }, { timeout: 4000 });
    await act(() => app.router.navigate({ to: "/activity" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Welcome to Opsifier" })).toBeNull());
    expect(JSON.parse(localStorage.getItem(USER_KEY) ?? "{}").tours).toEqual({ panel: "dismissed" });
  });

  it("leaves out a stop whose element is not on the screen", async () => {
    freshPanel({ "GET /server-purpose": purpose("development") });
    renderApp("/");
    // jsdom gives every element a size of zero: only the stops with no element remain.
    const card = await screen.findByRole("dialog", { name: "Welcome to Opsifier" }, { timeout: 4000 });
    expect(within(card).getByText("1 / 1")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Done" })).toBeTruthy();
  });
});

describe("where the card goes", () => {
  const card = { width: 380, height: 200 };
  const screenSize = { width: 1280, height: 800 };

  it("sits under the element when there is room, else above, else beside it", () => {
    expect(placeCard({ x: 100, y: 100, width: 100, height: 40 }, card, screenSize)).toEqual({
      left: 12,
      top: 152,
    });
    expect(placeCard({ x: 600, y: 700, width: 100, height: 40 }, card, screenSize)).toEqual({
      left: 460,
      top: 488,
    });
    expect(placeCard({ x: 100, y: 50, width: 100, height: 700 }, card, screenSize)).toEqual({
      left: 212,
      top: 50,
    });
    expect(placeCard({ x: 0, y: 0, width: 1280, height: 800 }, card, screenSize)).toEqual({
      right: 12,
      bottom: 12,
    });
    expect(placeCard(null, card, screenSize)).toEqual({ left: 450, top: 300 });
  });

  it("is a sheet on a phone, at the top when the element is in the lower half", () => {
    const phone = { width: 390, height: 844 };
    expect(placeCard({ x: 10, y: 100, width: 50, height: 30 }, card, phone)).toEqual({
      left: 12,
      right: 12,
      bottom: 12,
    });
    expect(placeCard({ x: 0, y: 800, width: 390, height: 40 }, card, phone)).toEqual({
      left: 12,
      right: 12,
      top: 12,
    });
  });
});

describe("the helpers", () => {
  it("tells private addresses from public ones", () => {
    for (const ip of [
      "10.0.0.5",
      "172.31.5.9",
      "192.168.1.20",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "fd00::1",
      "fe80::1",
      "::1",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["34.240.101.95", "52.17.1.2", "2a01:4f8:c17:1::1", "172.32.0.1"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("writes sslip.io names as the panel does", () => {
    expect(sslipBase("34.240.101.95")).toBe("34.240.101.95.sslip.io");
    expect(sslipBase("2a01:4f8::1")).toBe("2a01-4f8--1.sslip.io");
    expect(sslipBase("::1")).toBe("0--1.sslip.io");
  });

  it("reads the sample's stage from its service", () => {
    expect(stageOf(null)).toBe("idle");
    expect(stageOf(service())).toBe("idle");
    expect(stageOf(service({ status: "starting" }))).toBe("deploying");
    expect(stageOf(service({ activeAction: { id: "a", type: "template.deploy" } }))).toBe("deploying");
    expect(stageOf(service({ status: "running" }))).toBe("live");
    expect(stageOf(service({ wake: ["failed"] }))).toBe("failed");
    expect(stepStates("deploying", true)).toEqual(["running", "running", "progress", "unknown"]);
    expect(stepStates("failed", false)).toEqual(["failed", "unknown", "unknown", "unknown"]);
  });

  it("keeps the guide while only the sample runs", () => {
    const apps = { name: "apps", createdAt: "2026-01-01T00:00:00.000Z", services: [service()] };
    expect(onlySample([])).toBe(true);
    expect(onlySample([apps])).toBe(true);
    expect(onlySample([{ ...apps, services: [service(), service({ name: "web" })] }])).toBe(false);
  });
});
