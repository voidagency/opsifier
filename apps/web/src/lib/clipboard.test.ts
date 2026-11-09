// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

function stubClipboard(writeText: () => Promise<void>, secure = true) {
  vi.stubGlobal("isSecureContext", secure);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

describe("copyText", () => {
  let hostOfField: Element | null;
  let copiedValue: string | null;

  beforeEach(() => {
    hostOfField = null;
    copiedValue = null;
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => {
        const field = document.activeElement;
        if (!(field instanceof HTMLTextAreaElement)) return false;
        hostOfField = field.parentElement;
        copiedValue = field.value.slice(field.selectionStart, field.selectionEnd);
        return true;
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("uses the clipboard API when it is available", async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);

    await expect(copyText("secret")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("secret");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("falls back to a selection when the browser refuses the clipboard API", async () => {
    stubClipboard(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });

    await expect(copyText("secret")).resolves.toBe(true);
    expect(copiedValue).toBe("secret");
  });

  it("works without the clipboard API on plain HTTP", async () => {
    stubClipboard(async () => {}, false);

    await expect(copyText("secret")).resolves.toBe(true);
    expect(copiedValue).toBe("secret");
  });

  it("selects inside the open dialog, where a focus trap would otherwise block it", async () => {
    stubClipboard(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    document.body.innerHTML = `
      <div role="dialog" data-state="open" id="first"></div>
      <div role="dialog" data-state="open" id="top"><button id="copy">Copy</button></div>`;
    document.getElementById("copy")?.focus();

    await expect(copyText("secret")).resolves.toBe(true);
    expect(hostOfField).toBe(document.getElementById("top"));
  });

  it("leaves nothing behind and gives focus back", async () => {
    stubClipboard(async () => {}, false);
    document.body.innerHTML = '<button id="copy">Copy</button>';
    const button = document.getElementById("copy");
    button?.focus();

    await copyText("secret");
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("reports a failure instead of pretending it worked", async () => {
    stubClipboard(async () => {}, false);
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });

    await expect(copyText("secret")).resolves.toBe(false);
  });
});
