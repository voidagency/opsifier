// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { EmptyState, ErrorState } from "./EmptyState";
import { SectionIntro } from "./SectionIntro";

afterEach(cleanup);

describe("EmptyState", () => {
  it("draws the illustration it is given beside the text", () => {
    const { container } = render(
      <EmptyState illustration="no-domains" title="No domains yet" description="None to show." />,
    );
    expect(container.querySelector('[data-illustration="no-domains"]')).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No domains yet" })).toBeTruthy();
  });

  it("needs no picture", () => {
    const { container } = render(<EmptyState title="Empty" />);
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("ErrorState", () => {
  it("draws the failure, says why and offers to try again", () => {
    const onRetry = vi.fn();
    const { container } = render(<ErrorState message="The server said no." onRetry={onRetry} />);

    expect(container.querySelector('[data-illustration="not-found"]')).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("The server said no.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("offers no retry when there is nothing to retry", () => {
    render(<ErrorState message="Gone." />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("SectionIntro", () => {
  it("keeps the explanation folded until asked, with the state announced", () => {
    render(<SectionIntro pictogram="volume" title="Mounts" description="Folders and files." />);

    expect(screen.getByRole("heading", { name: "Mounts" })).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "What is this?" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Folders and files.").hidden).toBe(true);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Folders and files.").hidden).toBe(false);
  });

  it("offers no control when there is nothing to explain", () => {
    render(<SectionIntro pictogram="volume" title="Mounts" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
