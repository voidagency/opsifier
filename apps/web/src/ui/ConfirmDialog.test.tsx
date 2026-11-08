// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { ConfirmDialog } from "./ConfirmDialog";

afterEach(cleanup);

function Harness({ confirmText, onConfirm }: { confirmText?: string; onConfirm: () => unknown }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        reopen
      </button>
      <span data-testid="state">{open ? "open" : "closed"}</span>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete project"
        confirmLabel="Delete"
        confirmText={confirmText}
        onConfirm={onConfirm}
      />
    </>
  );
}

const confirmButton = () => screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
const nameInput = () => screen.getByRole("textbox") as HTMLInputElement;
const type = (value: string) => fireEvent.change(nameInput(), { target: { value } });

describe("ConfirmDialog with a name to type", () => {
  it("keeps the confirm button off until the exact name is typed", () => {
    render(<Harness confirmText="shop-api" onConfirm={vi.fn()} />);
    expect(confirmButton().disabled).toBe(true);

    type("shop");
    expect(confirmButton().disabled).toBe(true);

    type("SHOP-API");
    expect(confirmButton().disabled).toBe(true);

    type("shop-api ");
    expect(confirmButton().disabled).toBe(true);

    type("shop-api");
    expect(confirmButton().disabled).toBe(false);
  });

  it("confirms once when the name matches, then closes", async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(<Harness confirmText="shop-api" onConfirm={onConfirm} />);

    type("shop-api");
    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("closed"));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("ignores Enter while the name does not match", () => {
    const onConfirm = vi.fn();
    render(<Harness confirmText="shop-api" onConfirm={onConfirm} />);

    type("shop");
    fireEvent.submit(nameInput().closest("form") as HTMLFormElement);

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("state").textContent).toBe("open");
  });

  it("starts empty every time it opens", async () => {
    const onConfirm = vi.fn();
    render(<Harness confirmText="shop-api" onConfirm={onConfirm} />);

    type("shop-api");
    expect(confirmButton().disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("closed"));

    fireEvent.click(screen.getByText("reopen"));

    await waitFor(() => expect(nameInput().value).toBe(""));
    expect(confirmButton().disabled).toBe(true);
  });

  it("stays open and shows the problem when confirming fails", async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error("nope");
    });
    render(<Harness confirmText="shop-api" onConfirm={onConfirm} />);

    type("shop-api");
    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByTestId("state").textContent).toBe("open");
  });

  it("will not confirm twice while the first attempt is still running", async () => {
    let finish = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<Harness confirmText="shop-api" onConfirm={onConfirm} />);

    type("shop-api");
    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirmButton().getAttribute("aria-busy")).toBe("true"));

    fireEvent.click(confirmButton());
    fireEvent.submit(nameInput().closest("form") as HTMLFormElement);
    expect(onConfirm).toHaveBeenCalledOnce();

    finish();
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("closed"));
  });
});

describe("ConfirmDialog without a name to type", () => {
  it("is ready to confirm straight away", () => {
    render(<Harness onConfirm={vi.fn()} />);

    expect(confirmButton().disabled).toBe(false);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
