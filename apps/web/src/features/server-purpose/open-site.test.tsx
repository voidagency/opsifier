// @vitest-environment jsdom
import "../../testing/browser-stubs";
import type { ServerPurposeState } from "@opsifier/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepSessionBinding } from "../../lib/session-binding";
import { purposeKey } from "./api";
import { useOpenSite } from "./open-site";

const SITE = "https://shop-web.203.0.113.10.sslip.io/reports?week=3";
const HOP = `/api/v1/server-purpose/open?url=${encodeURIComponent(SITE)}`;

function SiteLink() {
  const openSite = useOpenSite();
  return (
    <a href={SITE} target="_blank" rel="noreferrer noopener" onClick={(event) => openSite(event, SITE)}>
      Open
    </a>
  );
}

const state = (protection: boolean): ServerPurposeState => ({
  purpose: protection ? "staging" : "production",
  protection,
  domains: [],
  protectedCount: 0,
  totalCount: 0,
  problems: [],
  confirmation: "PUBLIC 0",
});

function renderLink(protection: boolean): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(purposeKey, state(protection));
  render(
    <QueryClientProvider client={client}>
      <SiteLink />
    </QueryClientProvider>,
  );
  return screen.getByRole("link", { name: "Open" });
}

// jsdom can't follow a link: what the browser would do with one nobody took is left undone.
const leaveLinksAlone = (event: Event) => event.preventDefault();
let opened: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  document.addEventListener("click", leaveLinksAlone);
  opened = vi.spyOn(window, "open").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  document.removeEventListener("click", leaveLinksAlone);
  opened.mockRestore();
  keepSessionBinding(undefined);
});

describe("a link to one of the server's sites", () => {
  it("opens through the panel's hop while the sites ask for the password, keeping the site's address", () => {
    const link = renderLink(true);

    expect(link.getAttribute("href")).toBe(SITE);
    fireEvent.click(link);

    expect(opened).toHaveBeenCalledWith(HOP, "_blank", "noopener,noreferrer");
  });

  it("names the session's second secret, which a page the browser opens can't send as a header", () => {
    keepSessionBinding("b1nd");
    fireEvent.click(renderLink(true));

    expect(opened).toHaveBeenCalledWith(`${HOP}&binding=b1nd`, "_blank", "noopener,noreferrer");
  });

  it("leaves a click with a key held, another button and a site in production to the browser", () => {
    const link = renderLink(true);
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { shiftKey: true });
    fireEvent.click(link, { button: 1 });
    cleanup();
    fireEvent.click(renderLink(false));

    expect(opened).not.toHaveBeenCalled();
  });
});
