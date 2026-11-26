import { X } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui";
import type { TourEnd, TourId } from "./progress";
import type { TourStep } from "./tours";

/** Room left around the element a stop points at, and between it and the card. */
const HOLE_PADDING = 6;
const GAP = 12;
const EDGE = 12;
/** Under this width the card sits at the bottom of the screen, as a sheet, whatever it points at. */
const SHEET_BELOW = 640;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The element a stop points at: the first one on screen with that `data-tour`, since some come twice. */
export function findTarget(name: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(name)}"]`)) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden") {
      return element;
    }
  }
  return null;
}

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function holeOf(element: HTMLElement): Box {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left - HOLE_PADDING,
    y: rect.top - HOLE_PADDING,
    width: rect.width + HOLE_PADDING * 2,
    height: rect.height + HOLE_PADDING * 2,
  };
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

/** Where the card goes: under the element if it fits, else above, else beside it, else in the middle. */
export function placeCard(
  hole: Box | null,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
): CSSProperties {
  if (viewport.width < SHEET_BELOW) {
    // At the top when what it points at is in the lower half, as the bar along the bottom is.
    const low = hole !== null && hole.y + hole.height / 2 > viewport.height / 2;
    return low ? { left: EDGE, right: EDGE, top: EDGE } : { left: EDGE, right: EDGE, bottom: EDGE };
  }
  const centred = {
    left: Math.max(EDGE, (viewport.width - card.width) / 2),
    top: Math.max(EDGE, (viewport.height - card.height) / 2),
  };
  if (hole === null) {
    return centred;
  }
  const alongX = clamp(hole.x + hole.width / 2 - card.width / 2, EDGE, viewport.width - card.width - EDGE);
  const alongY = clamp(hole.y, EDGE, viewport.height - card.height - EDGE);
  const below = hole.y + hole.height + GAP;
  if (below + card.height <= viewport.height - EDGE) {
    return { left: alongX, top: below };
  }
  const above = hole.y - GAP - card.height;
  if (above >= EDGE) {
    return { left: alongX, top: above };
  }
  const right = hole.x + hole.width + GAP;
  if (right + card.width <= viewport.width - EDGE) {
    return { left: right, top: alongY };
  }
  const left = hole.x - GAP - card.width;
  if (left >= EDGE) {
    return { left, top: alongY };
  }
  // Around something as large as the screen, the card waits in a corner rather than over its middle.
  return { right: EDGE, bottom: EDGE };
}

export interface TourProps {
  tour: TourId;
  steps: readonly TourStep[];
  /** Values the stops' words may name, such as `{{base}}`. */
  values?: Record<string, string>;
  /** How the tour ended, or null when this screen had none of its stops to show, so it was never seen. */
  onEnd: (end: TourEnd | null) => void;
}

const sameBox = (a: Box | null, b: Box | null) =>
  a === b ||
  (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

/**
 * A guided tour: the screen dims, except the one element a stop is about, and a card says what it is.
 * The rest of the page can't be used meanwhile: Next and Back move along, Escape or Skip leave, and so do
 * the arrow keys and Enter. A stop whose element is not on the screen, hidden on a phone or for this
 * account, is left out.
 */
export function Tour({ tour, steps: allSteps, values, onEnd }: TourProps) {
  const { t } = useTranslation("onboarding");
  const titleId = useId();
  const bodyId = useId();
  const maskId = useId();
  // The stops this screen can show, decided once, when the tour starts.
  const [steps] = useState(() =>
    allSteps.filter((step) => step.target === undefined || findTarget(step.target)),
  );
  const [index, setIndex] = useState(0);
  const [hole, setHole] = useState<Box | null>(null);
  const [cardStyle, setCardStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const card = useRef<HTMLElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  // Off when what ends the tour moves focus somewhere of its own, as the command palette does.
  const restoreFocus = useRef(true);
  const step = steps[index];
  const last = index === steps.length - 1;

  const end = useCallback((how: TourEnd | null) => onEnd(how), [onEnd]);

  // Where the element is, and where the card goes, again whenever anything moves.
  const measure = useCallback(() => {
    const target = step?.target === undefined ? null : findTarget(step.target);
    const box = target === null ? null : holeOf(target);
    // Measured five times a second: only a real move draws again.
    setHole((current) => (sameBox(current, box) ? current : box));
    const size = card.current?.getBoundingClientRect() ?? { width: 380, height: 200 };
    const place = placeCard(box, size, { width: window.innerWidth, height: window.innerHeight });
    setCardStyle((current) => (JSON.stringify(current) === JSON.stringify(place) ? current : place));
  }, [step]);

  useLayoutEffect(() => {
    const target = step?.target === undefined ? null : findTarget(step.target);
    // Only as far as it takes to bring it into view: the bar along the bottom must not drag the page up.
    target?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: reducedMotion() ? "auto" : "smooth",
    });
    measure();
    // A smooth scroll and late layout move the element for a moment after the stop shows.
    const again = window.setInterval(measure, 200);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearInterval(again);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step, measure]);

  // Focus goes to the card's way forward at each stop, and back where it was once the tour ends: to the
  // page itself when that element has gone, as a menu's item has once the menu closed.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    return () => {
      root?.removeAttribute("inert");
      if (!restoreFocus.current) {
        return;
      }
      if (before?.isConnected && before !== document.body) {
        before.focus();
      } else {
        document.getElementById("main")?.focus();
      }
    };
  }, []);

  // The card is drawn anew at each stop, so focus enters a new dialog and its title and words are read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs at each stop
  useEffect(() => {
    next.current?.focus();
  }, [index]);

  useEffect(() => {
    if (steps.length === 0) {
      end(null);
    }
  }, [steps.length, end]);

  const forward = useCallback(() => {
    if (last) {
      end("done");
    } else {
      setIndex((current) => current + 1);
    }
  }, [last, end]);
  const back = useCallback(() => setIndex((current) => Math.max(0, current - 1)), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const modified = event.altKey || event.ctrlKey || event.metaKey;
      if (modified && event.key.toLowerCase() === "k") {
        // The command palette's shortcut, which the palette stop names: the tour makes way for it.
        restoreFocus.current = false;
        end("dismissed");
      } else if (modified) {
        // Alt with an arrow is the browser's Back, and the like: not the tour's.
      } else if (event.key === "Escape") {
        event.preventDefault();
        end("dismissed");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        forward();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        back();
      } else if (event.key === "Tab" && card.current !== null) {
        // Focus stays in the card: the page behind it can't be used during the tour.
        const focusable = [...card.current.querySelectorAll<HTMLElement>("button:not([disabled])")];
        const first = focusable[0];
        const final = focusable.at(-1);
        if (first === undefined || final === undefined) {
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          final.focus();
        } else if (!event.shiftKey && document.activeElement === final) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    // Before the page's own listeners, the command palette's among them.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [forward, back, end]);

  if (step === undefined) {
    return null;
  }

  const words = (part: "title" | "body") => t(`tours.${tour}.${step.id}.${part}`, values ?? {});
  const still = reducedMotion();

  return createPortal(
    <div className="fixed inset-0 z-[60]" data-testid="tour">
      <svg aria-hidden="true" className="absolute inset-0 size-full">
        <defs>
          <mask id={maskId}>
            <rect width="100%" height="100%" fill="white" />
            {hole && (
              <rect x={hole.x} y={hole.y} width={hole.width} height={hole.height} rx="3" fill="black" />
            )}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="var(--scrim)" mask={`url(#${maskId})`} />
      </svg>
      {hole && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 rounded-sm ring-2 ring-highlight"
          style={{
            width: hole.width,
            height: hole.height,
            transform: `translate(${hole.x}px, ${hole.y}px)`,
            transition: still
              ? undefined
              : "transform 160ms ease-out, width 160ms ease-out, height 160ms ease-out",
          }}
        />
      )}
      <section
        key={`${tour}-${index}`}
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="absolute grid w-[min(380px,calc(100vw-24px))] gap-3 rounded-sm border bg-raised p-4 shadow-overlay max-[639px]:w-auto"
        style={cardStyle}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-xs text-muted">
            {t("tour.progress", { current: index + 1, total: steps.length })}
          </p>
          <button
            type="button"
            aria-label={t("tour.close")}
            onClick={() => end("dismissed")}
            className="-mr-1.5 flex size-7 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        <div className="grid gap-1.5">
          <h2 id={titleId} className="text-md font-medium">
            {words("title")}
          </h2>
          <p id={bodyId} className="text-sm text-muted">
            {words("body")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!last && (
            <Button variant="ghost" onClick={() => end("dismissed")}>
              {t("tour.skip")}
            </Button>
          )}
          <span className="flex-1" />
          {index > 0 && <Button onClick={back}>{t("tour.back")}</Button>}
          <Button ref={next} variant="primary" onClick={forward}>
            {last ? t("tour.done") : t("tour.next")}
          </Button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
