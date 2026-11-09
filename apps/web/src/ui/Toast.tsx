import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/cn";

export type ToastTone = "neutral" | "success" | "error";

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** Time on screen in milliseconds. Errors stay longer by default. */
  duration?: number;
}

interface ToastEntry extends Required<Pick<ToastOptions, "title" | "tone" | "duration">> {
  id: number;
  description?: ReactNode;
  leaving: boolean;
}

const leaveDurationMs = 130;

let entries: readonly ToastEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function publish(next: readonly ToastEntry[]): void {
  entries = next;
  for (const listener of listeners) {
    listener();
  }
}

function remove(id: number): void {
  publish(entries.filter((entry) => entry.id !== id));
}

/**
 * Marks a toast as leaving so it can animate out, then removes it on a timer. The timer does not
 * wait for the animation, which never runs in a background tab or under reduced motion.
 */
function dismiss(id: number): void {
  publish(entries.map((entry) => (entry.id === id ? { ...entry, leaving: true } : entry)));
  setTimeout(() => remove(id), leaveDurationMs);
}

function show(options: ToastOptions): number {
  const id = nextId++;
  const tone = options.tone ?? "neutral";
  publish([
    ...entries,
    {
      id,
      title: options.title,
      description: options.description,
      tone,
      duration: options.duration ?? (tone === "error" ? 8000 : 4500),
      leaving: false,
    },
  ]);
  return id;
}

/** Shows a passing notification from anywhere, including outside React. */
export const toast = Object.assign(show, {
  success: (title: ReactNode, description?: ReactNode) => show({ title, description, tone: "success" }),
  error: (title: ReactNode, description?: ReactNode) => show({ title, description, tone: "error" }),
  dismiss,
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const icons = { neutral: Info, success: CircleCheck, error: CircleAlert };
const iconTones = { neutral: "text-off", success: "text-ok", error: "text-bad" };

function ToastItem({ entry }: { entry: ToastEntry }) {
  const { t } = useTranslation();
  const [paused, setPaused] = useState(false);
  const remaining = useRef(entry.duration);
  const startedAt = useRef(0);
  const Icon = icons[entry.tone];

  useEffect(() => {
    if (paused || entry.leaving) {
      return;
    }
    startedAt.current = Date.now();
    const timer = setTimeout(() => dismiss(entry.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - startedAt.current;
    };
  }, [paused, entry.id, entry.leaving]);

  return (
    <output
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-2.5 rounded-sm border bg-raised py-2.5 pr-2 pl-3 shadow-overlay",
        entry.leaving ? "animate-rise-out" : "animate-rise-in",
      )}
    >
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", iconTones[entry.tone])} />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{entry.title}</p>
        {entry.description && <p className="mt-0.5 text-muted">{entry.description}</p>}
      </div>
      <button
        type="button"
        aria-label={t("actions.dismiss")}
        onClick={() => dismiss(entry.id)}
        className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </output>
  );
}

/** Renders the toasts, bottom-right and above the activity tape. Mount once. */
export function Toaster() {
  const current = useSyncExternalStore(subscribe, () => entries);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 bottom-12 z-[70] ml-auto flex max-w-[450px] flex-col gap-2 sm:right-4 sm:left-auto sm:w-[450px]"
    >
      {current.map((entry) => (
        <ToastItem key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
