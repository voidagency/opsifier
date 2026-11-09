import { useRef } from "react";

/** The control that opened a dialog. A menu item is about to disappear, so it stands for its menu's button. */
function currentTrigger(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) {
    return null;
  }
  const menu = active.closest('[role="menu"]');
  const opener = menu?.id ? document.querySelector<HTMLElement>(`[aria-controls="${menu.id}"]`) : null;
  return opener ?? active;
}

/**
 * Radix only hands focus back to its own Trigger, and these dialogs are opened by ordinary buttons
 * and menu items, so on its own a closed dialog would leave focus on the page's body.
 * Pass the result as `onCloseAutoFocus`.
 */
export function useReturnFocus(open: boolean): (event: Event) => void {
  const trigger = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    trigger.current = currentTrigger();
  }
  wasOpen.current = open;

  return (event) => {
    event.preventDefault();
    const target = trigger.current?.isConnected ? trigger.current : document.getElementById("main");
    target?.focus();
  };
}
