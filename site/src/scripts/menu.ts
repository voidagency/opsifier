/**
 * The bar's links on a phone: folded under a Menu button, which opens them as a panel under the bar.
 * Without this script the button stays hidden and the links scroll sideways inside the bar, never the page.
 */
const bar = document.querySelector<HTMLElement>(".bar");
const toggle = bar?.querySelector<HTMLButtonElement>(".bar__menu");
const nav = bar?.querySelector<HTMLElement>("nav");

if (bar && toggle && nav) {
  const phone = matchMedia("(max-width: 640px)");

  const set = (open: boolean) => {
    bar.dataset.menu = open ? "open" : "closed";
    toggle.setAttribute("aria-expanded", String(open));
  };

  bar.dataset.menu = "closed";
  toggle.hidden = false;

  toggle.addEventListener("click", () => set(bar.dataset.menu !== "open"));

  // A link to a part of the same page leaves the page where it is: the panel goes, the part shows.
  nav.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a")) {
      set(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && bar.dataset.menu === "open") {
      set(false);
      toggle.focus();
    }
  });

  document.addEventListener("click", (event) => {
    if (bar.dataset.menu === "open" && !bar.contains(event.target as Node)) {
      set(false);
    }
  });

  // Back on a wide screen, the links are in the bar again.
  phone.addEventListener("change", () => set(false));
}
