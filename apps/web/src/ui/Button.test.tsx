// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { Button } from "./Button";
import { TooltipProvider } from "./Tooltip";

afterEach(cleanup);

const renderButton = (props: Parameters<typeof Button>[0]) =>
  render(
    <TooltipProvider>
      <Button {...props}>Deploy</Button>
    </TooltipProvider>,
  );

describe("a button that can't be used yet", () => {
  it("stays focusable, says it is off, and does nothing when pressed", () => {
    const onClick = vi.fn();
    renderButton({ onClick, disabledReason: "Deploy it first." });
    const button = screen.getByRole("button", { name: "Deploy" }) as HTMLButtonElement;

    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("explains what it needs when focused, so a keyboard can read it too", async () => {
    renderButton({ disabledReason: "Deploy it first." });

    fireEvent.focus(screen.getByRole("button", { name: "Deploy" }));

    expect((await screen.findAllByText("Deploy it first.")).length).toBeGreaterThan(0);
  });

  it("does not stop a form from being submitted when it is enabled", () => {
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    render(
      <TooltipProvider>
        <form onSubmit={onSubmit as never}>
          <Button type="submit">Save</Button>
        </form>
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
