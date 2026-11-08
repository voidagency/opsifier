// @vitest-environment jsdom
import "../../../testing/browser-stubs";
import type { DomainEntry, ServiceDetail } from "@opsifier/contract";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type FakeRoute,
  installFakeServer,
  renderApp,
  resetApp,
  withStatus,
} from "../../../testing/appHarness";

afterEach(resetApp);

const detail = (overrides: Partial<ServiceDetail> = {}): ServiceDetail => ({
  projectName: "shop",
  name: "web",
  type: "app",
  status: "running",
  replicas: { running: 1, desired: 1 },
  activeAction: null,
  wake: ["succeeded"],
  lastDeployedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  source: { type: "image", image: "traefik/whoami:v1.10", username: null, hasPassword: false },
  notes: "",
  stopped: false,
  primaryUrl: "https://shop-web.example.test/",
  ...overrides,
});

const metrics = {
  cpuPercent: 0,
  memoryUsedBytes: 0,
  networkRxBytes: 0,
  networkTxBytes: 0,
  readAt: null,
};

const base = (extra: FakeRoute = {}): FakeRoute => ({
  "GET /projects": { projects: [{ name: "shop", createdAt: "2026-01-01T00:00:00.000Z", services: [] }] },
  "GET /projects/shop/services/web": detail(),
  "GET /projects/shop/services/web/metrics": metrics,
  ...extra,
});

const domain = (overrides: Partial<DomainEntry> = {}): DomainEntry => ({
  id: "d1",
  host: "shop-web.example.test",
  path: "/",
  port: 80,
  https: true,
  primary: true,
  destinationProtocol: "http",
  destinationPath: "/",
  certificateResolver: null,
  wildcard: false,
  middlewares: [],
  url: "https://shop-web.example.test/",
  internalUrl: "http://shop_web:80/",
  ...overrides,
});

const DOMAINS = "GET /projects/shop/services/web/domains";
const PORTS = "GET /projects/shop/services/web/domains/exposed-ports";

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

describe("the domains tab", () => {
  it("offers to add a domain when there are none", async () => {
    installFakeServer(base({ [DOMAINS]: { domains: [] } }));
    renderApp("/projects/shop/app/web/domains");

    expect(await screen.findByText("No domains yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add domain" })).toBeTruthy();
  });

  it("explains a failure to load, and offers a retry", async () => {
    installFakeServer(
      base({ [DOMAINS]: withStatus(500, { error: { code: "internal_error", message: "x" } }) }),
    );
    renderApp("/projects/shop/app/web/domains");

    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("marks the primary domain, shows HTTP-only domains, and offers Make main on the others", async () => {
    installFakeServer(
      base({
        [DOMAINS]: {
          domains: [
            domain(),
            domain({
              id: "d2",
              host: "other.example.test",
              https: false,
              primary: false,
              url: "http://other.example.test/",
            }),
          ],
        },
      }),
    );
    renderApp("/projects/shop/app/web/domains");

    expect(await screen.findByRole("img", { name: "The service's main domain" })).toBeTruthy();
    expect(screen.getByText("HTTP only")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make this the main domain" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Edit this domain" })).toHaveLength(2);
  });

  it("creates a domain with the form's defaults", async () => {
    const server = installFakeServer(
      base({
        [DOMAINS]: { domains: [] },
        [PORTS]: { ports: [] },
        "POST /projects/shop/services/web/domains": domain(),
      }),
    );
    renderApp("/projects/shop/app/web/domains");

    fireEvent.click(await screen.findByRole("button", { name: "Add domain" }));
    expect(((await screen.findByLabelText("Hostname")) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe("/");
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("80");
    expect(screen.getByRole("switch", { name: /HTTPS/ }).getAttribute("aria-checked")).toBe("true");

    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "app.example.test" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));

    expect(await screen.findByText("Domain added")).toBeTruthy();
    const call = server.calls.find((entry) => entry.method === "POST");
    expect(call?.body).toEqual({
      https: true,
      host: "app.example.test",
      path: "/",
      destinationProtocol: "http",
      port: 80,
      destinationPath: "/",
      certificateResolver: null,
      wildcard: false,
      middlewares: [],
    });
  });

  it("checks the form before sending anything, and goes to the tab with the problem", async () => {
    const server = installFakeServer(base({ [DOMAINS]: { domains: [] }, [PORTS]: { ports: [] } }));
    renderApp("/projects/shop/app/web/domains");

    fireEvent.click(await screen.findByRole("button", { name: "Add domain" }));
    await screen.findByLabelText("Hostname");
    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "not a host" } });
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "noslash" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));

    expect(await screen.findByText("Enter a full hostname, such as app.example.com.")).toBeTruthy();
    expect(screen.getByText("A path starts with / and holds only URL path characters.")).toBeTruthy();

    // A wildcard without a resolver lands on the SSL tab.
    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "wild.example.test" } });
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "/" } });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "SSL" }), { button: 0 });
    fireEvent.click(await screen.findByRole("switch", { name: /Wildcard/ }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }), { button: 0 });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));

    expect(
      await screen.findByText("A wildcard certificate needs a named resolver that can do DNS challenges."),
    ).toBeTruthy();
    expect(server.calls.filter((entry) => entry.method === "POST")).toHaveLength(0);
  });

  it("shows a taken hostname on the field, and keeps the dialog open", async () => {
    installFakeServer(
      base({
        [DOMAINS]: { domains: [] },
        [PORTS]: { ports: [] },
        "POST /projects/shop/services/web/domains": withStatus(409, {
          error: {
            code: "domain_taken",
            message: "Another service already uses this hostname on this path",
            fields: { host: "Another service already uses this hostname on this path" },
          },
        }),
      }),
    );
    renderApp("/projects/shop/app/web/domains");

    fireEvent.click(await screen.findByRole("button", { name: "Add domain" }));
    await screen.findByLabelText("Hostname");
    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "taken.example.test" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));

    expect(await screen.findByText("This hostname and path are already taken.")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("adds middleware rows, and refuses to save a blank one", async () => {
    const server = installFakeServer(
      base({
        [DOMAINS]: { domains: [] },
        [PORTS]: { ports: [] },
        "POST /projects/shop/services/web/domains": domain(),
      }),
    );
    renderApp("/projects/shop/app/web/domains");

    fireEvent.click(await screen.findByRole("button", { name: "Add domain" }));
    await screen.findByLabelText("Hostname");
    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "app.example.test" } });

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Middlewares" }), { button: 0 });
    fireEvent.click(await screen.findByRole("button", { name: "Add middleware" }));
    fireEvent.click(screen.getByRole("button", { name: "Add middleware" }));
    expect(screen.getAllByLabelText(/^Middleware \d/)).toHaveLength(2);

    fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/Each middleware needs a name/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove middleware 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove middleware 1" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(server.calls.some((entry) => entry.method === "POST")).toBe(true));
    expect(server.calls.find((entry) => entry.method === "POST")?.body).toMatchObject({ middlewares: [] });
  });

  it("lists the image's ports, or says there are none", async () => {
    const server = installFakeServer(base({ [DOMAINS]: { domains: [] }, [PORTS]: { ports: [] } }));
    renderApp("/projects/shop/app/web/domains");

    fireEvent.click(await screen.findByRole("button", { name: "Add domain" }));
    await screen.findByLabelText("Hostname");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Choose" }), { button: 0 });
    expect(await screen.findByText("No suggestions yet")).toBeTruthy();
    expect(server.calls.some((entry) => entry.path.endsWith("/exposed-ports"))).toBe(true);
  });

  it("fills in the port when a suggestion is chosen", async () => {
    installFakeServer(base({ [DOMAINS]: { domains: [] }, [PORTS]: { ports: [8080, 9000] } }));
    renderApp("/projects/shop/app/web/domains");

    fireEvent.click(await screen.findByRole("button", { name: "Add domain" }));
    await screen.findByLabelText("Hostname");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Choose" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "9000" }));

    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("9000");
  });

  it("edits a domain with its current values", async () => {
    const existing = domain({
      path: "/api",
      port: 3000,
      destinationProtocol: "https",
      certificateResolver: "cloudflare",
      middlewares: ["rate-limit"],
    });
    const server = installFakeServer(
      base({
        [DOMAINS]: { domains: [existing] },
        [PORTS]: { ports: [] },
        "PUT /projects/shop/services/web/domains/d1": existing,
      }),
    );
    renderApp("/projects/shop/app/web/domains");

    fireEvent.click(await screen.findByRole("button", { name: "Edit this domain" }));
    expect(((await screen.findByLabelText("Hostname")) as HTMLInputElement).value).toBe(
      "shop-web.example.test",
    );
    expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe("/api");
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("3000");

    fireEvent.mouseDown(screen.getByRole("tab", { name: "SSL" }), { button: 0 });
    expect(((await screen.findByLabelText(/Certificate resolver/)) as HTMLInputElement).value).toBe(
      "cloudflare",
    );

    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Domain updated")).toBeTruthy();
    expect(server.calls.find((entry) => entry.method === "PUT")?.body).toMatchObject({
      path: "/api",
      port: 3000,
      destinationProtocol: "https",
      certificateResolver: "cloudflare",
      middlewares: ["rate-limit"],
    });
  });

  it("asks before deleting, and tells the server only after that", async () => {
    const server = installFakeServer(
      base({
        [DOMAINS]: { domains: [domain()] },
        "DELETE /projects/shop/services/web/domains/d1": { id: "d1" },
      }),
    );
    renderApp("/projects/shop/app/web/domains");

    fireEvent.click(await screen.findByRole("button", { name: "Delete this domain" }));
    expect(await screen.findByText("Delete this domain?")).toBeTruthy();
    expect(server.calls.some((entry) => entry.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Delete domain" }));
    expect(await screen.findByText("Domain deleted")).toBeTruthy();
    expect(server.calls.some((entry) => entry.method === "DELETE")).toBe(true);
  });

  it("asks before moving the star", async () => {
    const other = domain({
      id: "d2",
      host: "two.example.test",
      primary: false,
      url: "https://two.example.test/",
    });
    const server = installFakeServer(
      base({
        [DOMAINS]: { domains: [domain(), other] },
        "POST /projects/shop/services/web/domains/d2/primary": { ...other, primary: true },
      }),
    );
    renderApp("/projects/shop/app/web/domains");

    fireEvent.click(await screen.findByRole("button", { name: "Make this the main domain" }));
    fireEvent.click(await screen.findByRole("button", { name: "Make main" }));

    expect(await screen.findByText("Main domain changed")).toBeTruthy();
    expect(server.calls.some((entry) => entry.path.endsWith("/primary"))).toBe(true);
  });

  it("has no open link for a wildcard, which has no single address", async () => {
    installFakeServer(
      base({
        [DOMAINS]: {
          domains: [domain({ wildcard: true, primary: false, url: "https://*.shop-web.example.test/" })],
        },
      }),
    );
    renderApp("/projects/shop/app/web/domains");

    await screen.findByText("Wildcard");
    expect(screen.queryByRole("link", { name: "Open this address" })).toBeNull();
  });
});

const rule = {
  id: "r1",
  enabled: true,
  regex: "^http://host/old(.*)",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text of a replacement template
  replacement: "http://host/new${1}",
  permanent: false,
};
const REDIRECTS = "GET /projects/shop/services/web/redirects";

describe("the redirects tab", () => {
  it("offers to add one when there are none", async () => {
    installFakeServer(base({ [REDIRECTS]: { redirects: [] } }));
    renderApp("/projects/shop/app/web/redirects");

    expect(await screen.findByText("No redirects yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add redirect" })).toBeTruthy();
  });

  it("shows each rule, and a disabled one visibly", async () => {
    installFakeServer(
      base({ [REDIRECTS]: { redirects: [rule, { ...rule, id: "r2", enabled: false, permanent: true }] } }),
    );
    renderApp("/projects/shop/app/web/redirects");

    expect(await screen.findByText("Off")).toBeTruthy();
    expect(screen.getByText("Temporary (302)")).toBeTruthy();
    expect(screen.getByText("Permanent (301)")).toBeTruthy();
  });

  it("fills the form from an example and creates the rule", async () => {
    const server = installFakeServer(
      base({ [REDIRECTS]: { redirects: [] }, "POST /projects/shop/services/web/redirects": rule }),
    );
    renderApp("/projects/shop/app/web/redirects");

    fireEvent.click(await screen.findByRole("button", { name: "Add redirect" }));
    await screen.findByLabelText("Regular expression");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Start from an example" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Old path to new path" }));

    expect((screen.getByLabelText("Regular expression") as HTMLInputElement).value).toBe("^(.*)/old-path");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));

    expect(await screen.findByText("Redirects updated")).toBeTruthy();
    expect(server.calls.find((entry) => entry.method === "POST")?.body).toEqual({
      enabled: true,
      regex: "^(.*)/old-path",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text of a replacement template
      replacement: "${1}/new-path",
      permanent: false,
    });
  });

  it("refuses a pattern Traefik couldn't compile, before sending it", async () => {
    const server = installFakeServer(base({ [REDIRECTS]: { redirects: [] } }));
    renderApp("/projects/shop/app/web/redirects");

    fireEvent.click(await screen.findByRole("button", { name: "Add redirect" }));
    fireEvent.change(await screen.findByLabelText("Regular expression"), { target: { value: "(?=x)" } });
    fireEvent.change(screen.getByLabelText("Replacement"), { target: { value: "/y" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));

    expect(
      await screen.findByText("Enter a regular expression Traefik can compile, with no spaces."),
    ).toBeTruthy();
    expect(server.calls.some((entry) => entry.method === "POST")).toBe(false);
  });

  it("deletes after asking", async () => {
    const server = installFakeServer(
      base({
        [REDIRECTS]: { redirects: [rule] },
        "DELETE /projects/shop/services/web/redirects/r1": { id: "r1" },
      }),
    );
    renderApp("/projects/shop/app/web/redirects");

    fireEvent.click(await screen.findByRole("button", { name: "Delete this redirect" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete redirect" }));

    expect(await screen.findByText("Redirect deleted")).toBeTruthy();
    expect(server.calls.some((entry) => entry.method === "DELETE")).toBe(true);
  });
});

const BASIC_AUTH = "GET /projects/shop/services/web/basic-auth";

describe("the security tab", () => {
  it("says the service is open when no one is listed", async () => {
    installFakeServer(base({ [BASIC_AUTH]: { entries: [] } }));
    renderApp("/projects/shop/app/web/security");

    expect(await screen.findByText("This service is open to everyone")).toBeTruthy();
  });

  it("never shows a password: there is nothing to reveal", async () => {
    installFakeServer(base({ [BASIC_AUTH]: { entries: [{ id: "a1", username: "probeuser" }] } }));
    renderApp("/projects/shop/app/web/security");

    expect(await screen.findByText("probeuser")).toBeTruthy();
    expect(screen.getByText("Password stored as a hash, not shown here")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show password|Reveal/i })).toBeNull();
  });

  it("needs both fields to create a user", async () => {
    const server = installFakeServer(base({ [BASIC_AUTH]: { entries: [] } }));
    renderApp("/projects/shop/app/web/security");

    fireEvent.click(await screen.findByRole("button", { name: "Add a user" }));
    await screen.findByLabelText("Username");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));

    expect(await screen.findByText("Enter a username with no spaces or colons.")).toBeTruthy();
    expect(screen.getByText("Enter a password of up to 72 bytes.")).toBeTruthy();
    expect(server.calls.some((entry) => entry.method === "POST")).toBe(false);
  });

  it("creates a user", async () => {
    const server = installFakeServer(
      base({
        [BASIC_AUTH]: { entries: [] },
        "POST /projects/shop/services/web/basic-auth": { id: "a1", username: "bob" },
      }),
    );
    renderApp("/projects/shop/app/web/security");

    fireEvent.click(await screen.findByRole("button", { name: "Add a user" }));
    fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "bob" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a secret" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add" }));

    expect(await screen.findByText("Basic authentication updated")).toBeTruthy();
    expect(server.calls.find((entry) => entry.method === "POST")?.body).toEqual({
      username: "bob",
      password: "a secret",
    });
  });

  it("leaves the password out of an edit when it stays blank", async () => {
    const server = installFakeServer(
      base({
        [BASIC_AUTH]: { entries: [{ id: "a1", username: "bob" }] },
        "PUT /projects/shop/services/web/basic-auth/a1": { id: "a1", username: "robert" },
      }),
    );
    renderApp("/projects/shop/app/web/security");

    fireEvent.click(await screen.findByRole("button", { name: "Edit this user" }));
    expect(((await screen.findByLabelText("Password")) as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "robert" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Basic authentication updated")).toBeTruthy();
    expect(server.calls.find((entry) => entry.method === "PUT")?.body).toEqual({ username: "robert" });
  });
});

const maintenance = {
  enabled: false,
  title: "",
  subtitle: "",
  customLogo: null,
  customCss: "",
  hideLogo: false,
  hideLinks: false,
};
const MAINTENANCE = "GET /projects/shop/services/web/maintenance";

describe("the maintenance tab", () => {
  it("starts off, and turns on with its fields", async () => {
    const saved = { ...maintenance, enabled: true, title: "Maint title", subtitle: "Back soon" };
    const server = installFakeServer(
      base({ [MAINTENANCE]: maintenance, "PUT /projects/shop/services/web/maintenance": saved }),
    );
    renderApp("/projects/shop/app/web/maintenance");

    const toggle = await screen.findByRole("switch", { name: /Show the maintenance page/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Maint title" } });
    fireEvent.change(screen.getByLabelText("Subtitle"), { target: { value: "Back soon" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Maintenance page on")).toBeTruthy();
    expect(server.calls.find((entry) => entry.method === "PUT")?.body).toMatchObject({
      enabled: true,
      title: "Maint title",
      subtitle: "Back soon",
    });
  });

  it("says when the page is on", async () => {
    installFakeServer(base({ [MAINTENANCE]: { ...maintenance, enabled: true, title: "Down" } }));
    renderApp("/projects/shop/app/web/maintenance");

    expect(await screen.findByText("The maintenance page is on")).toBeTruthy();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Down");
  });

  it("offers a retry when it can't load", async () => {
    installFakeServer(
      base({ [MAINTENANCE]: withStatus(500, { error: { code: "internal_error", message: "x" } }) }),
    );
    renderApp("/projects/shop/app/web/maintenance");

    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("refuses CSS that would break out of its style element", async () => {
    const server = installFakeServer(base({ [MAINTENANCE]: maintenance }));
    renderApp("/projects/shop/app/web/maintenance");

    fireEvent.change(await screen.findByLabelText(/Custom CSS/), {
      target: { value: "</style><script>x</script>" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("This CSS is too long or contains </style.")).toBeTruthy();
    expect(server.calls.some((entry) => entry.method === "PUT")).toBe(false);
  });

  it("removes a logo", async () => {
    const logo = "data:image/png;base64,iVBORw0KGgo=";
    const server = installFakeServer(
      base({
        [MAINTENANCE]: { ...maintenance, customLogo: logo },
        "PUT /projects/shop/services/web/maintenance": maintenance,
      }),
    );
    renderApp("/projects/shop/app/web/maintenance");

    await screen.findByAltText("The chosen logo");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByAltText("The chosen logo")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.calls.some((entry) => entry.method === "PUT")).toBe(true));
    expect(server.calls.find((entry) => entry.method === "PUT")?.body).toMatchObject({ customLogo: null });
  });
});
