// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown, parseMarkdownBlocks } from "./Markdown";

afterEach(cleanup);

describe("parseMarkdownBlocks", () => {
  it("recognises headings, lists, code and paragraphs", () => {
    expect(parseMarkdownBlocks("# Title\n\nSome text\nmore\n\n- a\n- b\n\n```\ncode\n```")).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", text: "Some text more" },
      { kind: "list", ordered: false, items: ["a", "b"] },
      { kind: "code", text: "code" },
    ]);
  });
});

describe("Markdown", () => {
  it("renders headings and emphasis as elements", () => {
    render(<Markdown text={"# Runbook\n\nRestart **first**, then *verify* `logs`."} />);

    expect(screen.getByRole("heading", { name: "Runbook" })).toBeTruthy();
    expect(screen.getByText("first").tagName).toBe("STRONG");
    expect(screen.getByText("verify").tagName).toBe("EM");
    expect(screen.getByText("logs").tagName).toBe("CODE");
  });

  it("never turns HTML in a note into markup", () => {
    const { container } = render(<Markdown text={"<img src=x onerror=alert(1)> <b>bold</b>"} />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
  });

  it("only makes safe links live", () => {
    render(<Markdown text={"[docs](https://example.com/a) and [bad](javascript:alert(1))"} />);

    expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe("https://example.com/a");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
