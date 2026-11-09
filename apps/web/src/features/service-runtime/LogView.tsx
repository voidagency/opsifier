import { memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { formatDateTime, timeZoneLabel } from "../../lib/format";
import { type LogEntry, type LogView as LogViewData, MAX_LOG_ENTRIES } from "./logStore";

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

/** Where the feed gave up on output it could not keep up with, so a jump in the times makes sense. */
function Gap({ entry }: { entry: Extract<LogEntry, { kind: "gap" }> }) {
  const { t } = useTranslation("service-runtime");
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-muted">
      <hr className="flex-1 border-t border-dashed border-off" />
      <span className="tabular-nums">
        {clock(entry.at)} {t("logs.skipped")}
      </span>
      <hr className="flex-1 border-t border-dashed border-off" />
    </div>
  );
}

/** Which service this is, from when, and how much of it stays on screen. */
export function LogScope({
  project,
  service,
  view,
}: {
  project: string;
  service: string;
  view: LogViewData;
}) {
  const { t, i18n } = useTranslation("service-runtime");
  const first = view.entries.find((entry) => entry.kind === "line" && entry.at !== null);
  const limit = MAX_LOG_ENTRIES.toLocaleString(i18n.language);
  const since = first?.kind === "line" && first.at !== null ? formatDateTime(first.at, i18n.language) : null;
  const help =
    view.limits === null
      ? t("logs.scopeHelpShort", { limit })
      : t("logs.scopeHelp", {
          tail: view.limits.tailLines.toLocaleString(i18n.language),
          ring: view.limits.ringLines.toLocaleString(i18n.language),
          limit,
        });
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted" title={help}>
      <span className="min-w-0 font-mono break-all text-ink">{`${project}/${service}`}</span>
      <span>{since === null ? t("logs.live") : t("logs.since", { when: since })}</span>
      <span>{t("logs.latest", { limit })}</span>
      {view.paused && <span className="font-medium text-ink">{t("logs.paused", { count: view.held })}</span>}
    </p>
  );
}

interface LogLinesProps {
  view: LogViewData;
  /** The Swarm service's name, shown while it isn't running. */
  name: string;
  className?: string;
  /** Whether a filter stands between what arrived and what is shown. */
  filtered?: boolean;
}

/** The scrolling text of a log, which follows the end unless the reader has scrolled up. */
export function LogLines({ view, name, className, filtered = false }: LogLinesProps) {
  const { t, i18n } = useTranslation("service-runtime");
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
      <p className="sticky top-0 z-10 bg-raised px-3 pb-1 font-sans text-micro text-muted">
        {t("logs.timeZone", { zone: timeZoneLabel(i18n.language) })}
      </p>
      {view.entries.map((entry) => {
        if (entry.kind === "line") {
          return <LogLine key={entry.key} entry={entry} />;
        }
        return entry.kind === "gap" ? (
          <Gap key={entry.key} entry={entry} />
        ) : (
          <Separator key={entry.key} entry={entry} />
        );
      })}
      <LogStatus state={view.state} name={name} empty={view.entries.length === 0} filtered={filtered} />
    </div>
  );
}

function LogStatus({
  state,
  name,
  empty,
  filtered,
}: {
  state: LogViewData["state"];
  name: string;
  empty: boolean;
  filtered: boolean;
}) {
  const { t } = useTranslation("service-runtime");
  if (state === "streaming" && !empty) {
    return null;
  }
  const message =
    empty && filtered
      ? t("logs.noMatch")
      : state === "waiting"
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
