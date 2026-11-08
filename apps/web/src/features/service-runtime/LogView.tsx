import { memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import type { LogEntry, LogView as LogViewData } from "./logStore";

const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function clock(at: string | number | null): string {
  if (at === null) {
    return "";
  }
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : clockFormat.format(date);
}

const LogLine = memo(function LogLine({ entry }: { entry: Extract<LogEntry, { kind: "line" }> }) {
  return (
    <div
      className={cn(
        "relative flex items-start gap-3 px-3 py-px hover:bg-wash",
        entry.stream === "stderr" &&
          "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-bad",
      )}
    >
      <span aria-hidden="true" className="shrink-0 select-none text-muted tabular-nums">
        {clock(entry.at)}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{entry.text}</span>
    </div>
  );
});

function Separator({ entry }: { entry: Extract<LogEntry, { kind: "separator" }> }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-muted">
      <hr className="flex-1 border-t border-dashed border-off" />
      <span className="tabular-nums">{clock(entry.at)}</span>
      <hr className="flex-1 border-t border-dashed border-off" />
    </div>
  );
}

interface LogLinesProps {
  view: LogViewData;
  /** The Swarm service's name, shown while it isn't running. */
  name: string;
  className?: string;
}

/** The scrolling text of a log, which follows the end unless the reader has scrolled up. */
export function LogLines({ view, name, className }: LogLinesProps) {
  const { t } = useTranslation("service-runtime");
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs whenever the content changes
  useEffect(() => {
    const element = scroller.current;
    if (element !== null && pinned.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [view]);

  return (
    <div
      ref={scroller}
      role="log"
      aria-label={t("logs.label")}
      // Scrolling with the keyboard needs the element to be focusable.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the log scrolls
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
      className={cn(
        "overflow-y-auto overscroll-contain rounded-sm border bg-raised py-2 font-mono text-xs",
        className,
      )}
    >
      {view.entries.map((entry) =>
        entry.kind === "line" ? (
          <LogLine key={entry.key} entry={entry} />
        ) : (
          <Separator key={entry.key} entry={entry} />
        ),
      )}
      <LogStatus state={view.state} name={name} empty={view.entries.length === 0} />
    </div>
  );
}

function LogStatus({ state, name, empty }: { state: LogViewData["state"]; name: string; empty: boolean }) {
  const { t } = useTranslation("service-runtime");
  if (state === "streaming" && !empty) {
    return null;
  }
  const message =
    state === "waiting"
      ? t("logs.waiting", { name })
      : state === "error"
        ? t("logs.error")
        : state === "connecting"
          ? t("logs.connecting")
          : t("logs.empty");
  return (
    <p className="flex items-center gap-2 px-3 py-1 text-muted">
      {state === "waiting" && (
        <span
          aria-hidden="true"
          className="size-1.5 animate-pulse rounded-[1px] bg-busy motion-reduce:animate-none"
        />
      )}
      {message}
    </p>
  );
}
