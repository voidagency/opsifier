import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const PHONE_LAMPS = 88;

type State = "failed" | "degraded" | "unknown" | "stopped" | "progress" | "running";

interface Lamp {
  el: SVGSVGElement;
  use: SVGUseElement;
  initial: State;
  start: number;
  end: number;
  now: State;
}

/** The one variable behind the signature: every light, the gauge, the counts and the word follow it. */
function setupBoard(board: HTMLElement) {
  const every: Lamp[] = [...board.querySelectorAll<SVGSVGElement>(".lamp[data-s]")].map((el) => ({
    el,
    use: el.querySelector("use") as SVGUseElement,
    initial: el.dataset.state as State,
    start: Number(el.dataset.s) / 1000,
    end: Number(el.dataset.e) / 1000,
    now: el.dataset.state as State,
  }));
  const word = board.querySelector<HTMLElement>("[data-word]");
  const percent = board.querySelector<HTMLElement>("[data-percent]");
  const arc = board.querySelector<SVGCircleElement>("[data-arc]");
  const hint = document.querySelector<HTMLElement>("[data-hint]");
  const counters = new Map(
    [...board.querySelectorAll<HTMLElement>("[data-count]")].map((el) => [el.dataset.count as State, el]),
  );
  const text = board.dataset;
  let lamps = every;
  let lastWord = "";

  const stateAt = (lamp: Lamp, progress: number): State => {
    if (lamp.initial === "running" || progress < lamp.start) {
      return lamp.initial;
    }
    return progress < lamp.end ? "progress" : "running";
  };

  function render(progress: number) {
    const counts: Record<State, number> = { failed: 0, degraded: 0, unknown: 0, stopped: 0, progress: 0, running: 0 };
    for (const lamp of lamps) {
      const state = stateAt(lamp, progress);
      counts[state] += 1;
      if (state !== lamp.now) {
        lamp.now = state;
        lamp.el.dataset.state = state;
        lamp.use.setAttribute("href", `#l-${state}`);
      }
    }
    for (const [state, el] of counters) {
      const value = String(counts[state]);
      if (el.textContent !== value) {
        el.textContent = value;
      }
    }
    const share = counts.running / lamps.length;
    if (percent) {
      percent.textContent = `${Math.round(share * 100)}%`;
    }
    arc?.setAttribute("stroke-dasharray", `${share * 350.5} 360`);

    const problems = counts.failed + counts.degraded + counts.unknown;
    const clear = counts.running === lamps.length;
    const phrase = clear
      ? (text.clearText ?? "")
      : problems > 0
        ? `${problems} ${problems === 1 ? text.problemText : text.problemsText}`
        : (text.deployingText ?? "");
    if (word && phrase !== lastWord) {
      lastWord = phrase;
      word.textContent = phrase;
    }
    board.toggleAttribute("data-clear", clear);
    if (hint) {
      hint.style.opacity = progress > 0.04 ? "0" : "1";
    }
  }

  if (reduced) {
    render(1);
    return;
  }

  const responsive = gsap.matchMedia();
  responsive.add({ wide: "(min-width: 1000px)", phone: "(max-width: 639.98px)", any: "all" }, (context) => {
    const wide = context.conditions?.wide === true;
    lamps = context.conditions?.phone === true ? every.slice(0, PHONE_LAMPS) : every;
    const drive = { progress: 0 };
    render(0);
    gsap.to(drive, {
      progress: 1,
      ease: "none",
      onUpdate: () => render(drive.progress),
      scrollTrigger: wide
        ? { trigger: "[data-stage]", start: "top top+=68", end: "bottom bottom", scrub: 0.35, invalidateOnRefresh: true }
        : { trigger: "[data-track]", start: "top 22%", end: "bottom bottom", scrub: 0.35, invalidateOnRefresh: true },
    });
  });
}

function setupReveals() {
  if (reduced) {
    return;
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-reveal]")) {
    gsap.from(el, {
      y: 26,
      opacity: 0,
      duration: 0.7,
      ease: "power3.out",
      scrollTrigger: { trigger: el, start: "top 90%", once: true },
    });
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-shot]")) {
    gsap.from(el, {
      y: 56,
      clipPath: "inset(0 0 22% 0)",
      duration: 1,
      ease: "power3.out",
      scrollTrigger: { trigger: el, start: "top 88%", once: true },
    });
  }
}

function setLamp(lamp: SVGSVGElement, state: State) {
  lamp.dataset.state = state;
  lamp.querySelector("use")?.setAttribute("href", `#l-${state}`);
}

/** Each row deploys as it arrives, by the same rule as the board. */
function setupRowLamps() {
  if (reduced) {
    return;
  }
  for (const lamp of document.querySelectorAll<SVGSVGElement>("[data-settle]")) {
    setLamp(lamp, "progress");
    ScrollTrigger.create({
      trigger: lamp.closest("li"),
      start: "top 70%",
      once: true,
      onEnter: () => {
        gsap.delayedCall(0.6, () => setLamp(lamp, "running"));
      },
    });
  }
}

/** Only a chosen link glides. Focus and the skip link have to land at once. */
function setupAnchors() {
  if (reduced) {
    return;
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href*="#"]:not(.skip)')) {
    if (link.pathname !== location.pathname) {
      continue;
    }
    link.addEventListener("click", () => {
      document.documentElement.style.scrollBehavior = "smooth";
      gsap.delayedCall(2, () => {
        document.documentElement.style.scrollBehavior = "";
      });
    });
  }
}

/** The same alphabet the address service issues names from: nothing that can be misread, no vowels. */
function setupAddress() {
  const id = document.querySelector<HTMLElement>("[data-id]");
  const button = document.querySelector<HTMLButtonElement>("[data-another]");
  if (!id || !button) {
    return;
  }
  const letters = "bcdfghjkmnpqrstvwxyz";
  const alphabet = `${letters}23456789`;
  const pick = (from: string) => from[crypto.getRandomValues(new Uint32Array(1))[0] % from.length];
  button.addEventListener("click", () => {
    let next = pick(letters);
    while (next.length < 8) {
      next += pick(alphabet);
    }
    id.textContent = next;
    if (!reduced) {
      gsap.fromTo(id, { y: 10, autoAlpha: 0.2 }, { y: 0, autoAlpha: 1, duration: 0.36, ease: "power3.out" });
    }
  });
}

function setupTabs() {
  for (const root of document.querySelectorAll<HTMLElement>("[data-tabs]")) {
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const select = (tab: HTMLButtonElement, focus: boolean) => {
      for (const other of tabs) {
        const on = other === tab;
        other.setAttribute("aria-selected", String(on));
        other.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(other.getAttribute("aria-controls") ?? "");
        if (panel) {
          panel.hidden = !on;
        }
      }
      if (focus) {
        tab.focus();
      }
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => select(tab, false));
      tab.addEventListener("keydown", (event) => {
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (step !== 0) {
          event.preventDefault();
          select(tabs[(index + step + tabs.length) % tabs.length], true);
        }
      });
    });
  }
}

function setupCopy() {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    const original = button.textContent ?? "";
    button.addEventListener("click", async () => {
      const source = button.closest("[data-code]")?.querySelector("[data-source]")?.textContent ?? "";
      try {
        await navigator.clipboard.writeText(source);
        button.textContent = button.dataset.done ?? original;
        setTimeout(() => {
          button.textContent = original;
        }, 1600);
      } catch {
        // Without clipboard access the commands are still there to select.
      }
    });
  }
}

const board = document.querySelector<HTMLElement>("[data-board]");
if (board) {
  setupBoard(board);
}
setupReveals();
setupRowLamps();
setupAnchors();
setupAddress();
setupTabs();
setupCopy();
