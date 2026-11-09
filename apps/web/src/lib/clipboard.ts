/**
 * Copies text to the clipboard. The panel is often first reached over plain HTTP, where
 * `navigator.clipboard` does not exist, and some embedded browsers refuse it, so the older
 * selection-based route is kept as a fallback.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or document not focused: fall through to the selection route.
    }
  }
  return copyBySelection(text);
}

/** The topmost open modal. Its focus trap takes focus back from anything placed outside it. */
function openModal(): HTMLElement | null {
  const modals = document.querySelectorAll<HTMLElement>(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
  );
  return modals[modals.length - 1] ?? null;
}

function copyBySelection(text: string): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.tabIndex = -1;
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.width = "1px";
  area.style.height = "1px";
  area.style.opacity = "0";

  (openModal() ?? document.body).append(area);
  area.focus({ preventScroll: true });
  area.select();
  area.setSelectionRange(0, text.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  area.remove();
  previous?.focus({ preventScroll: true });
  return copied;
}
