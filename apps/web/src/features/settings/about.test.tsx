// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp, SIGNED_IN } from "../../testing/appHarness";

afterEach(resetApp);

const ABOUT = {
  version: "0.6.1",
  license: "Apache-2.0",
  copyright: "Copyright 2026 Opsifier contributors",
  sourceUrl: "https://github.com/voidagency/opsifier",
  licenseUrl: "https://github.com/voidagency/opsifier/blob/main/LICENSE",
  noticesFile: "/usr/share/doc/opsifier/THIRD-PARTY-NOTICES.txt",
  components: [
    {
      name: "restic",
      version: "0.19.1",
      license: "BSD-2-Clause",
      url: "https://restic.net",
      kind: "program",
    },
    {
      name: "Docker CLI",
      version: null,
      license: "Apache-2.0",
      url: "https://github.com/docker/cli",
      kind: "program",
    },
    { name: "hono", version: "4.9.0", license: "MIT", url: "https://hono.dev", kind: "package" },
  ],
};
const INFO = { version: "0.6.1", serverIp: null, simulated: false };
const MEMBER = {
  ...SIGNED_IN,
  user: { ...SIGNED_IN.user, email: "ada@example.com", role: "member", hostAdmin: false },
};

describe("the About page", () => {
  it("names the license, links to the code, and lists the software the image ships", async () => {
    installFakeServer({
      "GET /auth/session": SIGNED_IN,
      "GET /system/about": ABOUT,
      "GET /system/info": INFO,
    });
    renderApp("/settings/about");

    expect(await screen.findByText("About Opsifier", { selector: "h2" })).toBeTruthy();
    expect(screen.getByText(/free and open-source software, under the Apache License 2.0/)).toBeTruthy();
    expect(screen.getByText("Copyright 2026 Opsifier contributors")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Read the license" }).getAttribute("href")).toBe(
      ABOUT.licenseUrl,
    );
    expect(screen.getByRole("link", { name: "Source code on GitHub" }).getAttribute("href")).toBe(
      ABOUT.sourceUrl,
    );
    expect(screen.getByRole("link", { name: "What this version changed" }).getAttribute("href")).toBe(
      "https://github.com/voidagency/opsifier/releases/tag/v0.6.1",
    );
    expect(screen.getByText("2 programs")).toBeTruthy();
    expect(screen.getByRole("link", { name: "restic" }).getAttribute("href")).toBe("https://restic.net");
    expect(screen.getByText("from its repository")).toBeTruthy();
    expect(screen.getByText("1 JavaScript package")).toBeTruthy();
    expect(screen.getByText(ABOUT.noticesFile)).toBeTruthy();
  });

  it("is in the settings of every account, members included", async () => {
    installFakeServer({ "GET /auth/session": MEMBER, "GET /system/about": ABOUT, "GET /system/info": INFO });
    renderApp("/settings/about");

    expect(await screen.findByText("About Opsifier", { selector: "h2" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "About" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "General" })).toBeNull();
  });

  it("opens from the version line of the account menu", async () => {
    installFakeServer({
      "GET /auth/session": SIGNED_IN,
      "GET /system/about": ABOUT,
      "GET /system/info": INFO,
    });
    renderApp("/settings/user/authentication");

    const trigger = await screen.findByRole("button", { name: "Account menu" });
    act(() => trigger.focus());
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const item = await screen.findByRole("menuitem", { name: "Opsifier v0.6.1 · Apache 2.0" });
    fireEvent.click(item);

    expect(await screen.findByText("About Opsifier", { selector: "h2" })).toBeTruthy();
  });

  it("says so when the panel does not run from its image", async () => {
    installFakeServer({
      "GET /auth/session": SIGNED_IN,
      "GET /system/about": { ...ABOUT, noticesFile: null, components: [] },
      "GET /system/info": INFO,
    });
    renderApp("/settings/about");

    expect(await screen.findByText(/not running from its image/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
