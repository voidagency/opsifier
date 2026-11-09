// @vitest-environment jsdom
import "../testing/browser-stubs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import "../i18n";
import { Dialog } from "./Dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./DropdownMenu";

afterEach(cleanup);

function FromButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <button type="button">other</button>
      <Dialog open={open} onOpenChange={setOpen} title="Edit" footer={<span>footer</span>}>
        <input aria-label="field" />
      </Dialog>
    </>
  );
}

function FromMenu() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => setOpen(true)}>edit</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open} onOpenChange={setOpen} title="Edit">
        <input aria-label="field" />
      </Dialog>
    </>
  );
}

describe("every dialog", () => {
  it("has a name, takes focus, and offers a close control", async () => {
    render(<FromButton />);
    const opener = screen.getByRole("button", { name: "open" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole("dialog", { name: "Edit" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("gives focus back to the button that opened it, by Escape or its close control", async () => {
    render(<FromButton />);
    const opener = screen.getByRole("button", { name: "open" });

    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);

    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("gives focus back to the menu's button when a menu item opened it", async () => {
    render(<FromMenu />);
    const trigger = screen.getByRole("button", { name: "menu" });
    act(() => trigger.focus());
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    act(() => screen.getByRole("menuitem", { name: "edit" }).focus());

    fireEvent.click(screen.getByRole("menuitem", { name: "edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
