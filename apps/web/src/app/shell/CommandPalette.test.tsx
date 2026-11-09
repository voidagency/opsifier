// @vitest-environment jsdom
import "../../testing/browser-stubs";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeServer, renderApp, resetApp } from "../../testing/appHarness";

afterEach(resetApp);

const projects = { projects: [], viewer: { admin: true, canCreate: true } };

async function openPalette() {
  installFakeServer({ "GET /projects": projects });
  renderApp("/");
  await screen.findByRole("navigation", { name: "Breadcrumb" });
  fireEvent.keyDown(document, { key: "k", ctrlKey: true });
  return within(await screen.findByRole("dialog", { name: "Command palette" }));
}

describe("the command palette", () => {
  it("can be closed with a control, not only with Escape", async () => {
    const palette = await openPalette();

    fireEvent.click(palette.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes on Escape and takes focus into its search box when it opens", async () => {
    const palette = await openPalette();

    await waitFor(() => expect(document.activeElement).toBe(palette.getByRole("combobox")));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
