import { type ActionEntry, actionPage, actionsTopic } from "@opsifier/contract";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionLog } from "../../features/activity/ActionLog";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import { useConnectionStatus, useTopic } from "../../lib/realtime";
import { StatusLamp } from "../../ui";

const finishedLingerMs = 5000;

function isActive(action: ActionEntry): boolean {
  return action.status === "queued" || action.status === "running";
}

function lampFor(action: ActionEntry) {
  switch (action.status) {
    case "queued":
      return "off" as const;
    case "running":
      return "busy" as const;
    case "succeeded":
      return "ok" as const;
    case "failed":
      return "bad" as const;
    default:
      return "off" as const;
  }
}

function formatElapsed(fromIso: string | null, now: number): string {
  if (!fromIso) {
    return "--:--";
  }
  const seconds = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const mm = String(minutes % 60).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}

/**
 * The actions the tape shows: queued and running, plus anything that just finished, for a moment.
 * The list is fetched once for the initial state and after every reconnect. From then on the
 * `actions` topic keeps it current.
 */
function useTapeActions(): ActionEntry[] {
  const queryClient = useQueryClient();
  const connection = useConnectionStatus();
  const [live, setLive] = useState<ReadonlyMap<string, ActionEntry>>(new Map());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const results = useQueries({
    queries: (["running", "queued"] as const).map((status) => ({
      queryKey: ["actions", "tape", status],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get("/actions", { query: { status, limit: 50 }, schema: actionPage, signal }),
      staleTime: 0,
    })),
  });

  const fetched = useMemo(() => results.flatMap((result) => result.data?.items ?? []), [results]);

  const wasOpen = useRef(false);
  useEffect(() => {
    if (connection === "open") {
      if (wasOpen.current) {
        void queryClient.invalidateQueries({ queryKey: ["actions", "tape"] });
      }
      wasOpen.current = true;
    }
  }, [connection, queryClient]);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) {
        clearTimeout(timer);
      }
    },
    [],
  );

  useTopic<ActionEntry>(actionsTopic, (action) => {
    const existing = timers.current.get(action.id);
    if (existing) {
      clearTimeout(existing);
      timers.current.delete(action.id);
    }
    // Finished-on-arrival entries with no output are records, like a sign-in, not work to follow.
    const record = !isActive(action) && !action.hasLog;
    setLive((current) => {
      if (record && !current.has(action.id)) {
        return current;
      }
      return new Map(current).set(action.id, action);
    });
    if (!isActive(action)) {
      timers.current.set(
        action.id,
        setTimeout(() => {
          timers.current.delete(action.id);
          setLive((current) => {
            const next = new Map(current);
            next.delete(action.id);
            return next;
          });
        }, finishedLingerMs),
      );
    }
  });

  return useMemo(() => {
    const merged = new Map<string, ActionEntry>(fetched.map((action) => [action.id, action]));
    for (const [id, action] of live) {
      merged.set(id, action);
    }
    // A finished action that left the live map may still be in an older fetched list.
    return [...merged.values()]
      .filter((action) => isActive(action) || live.has(action.id))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }, [fetched, live]);
}

function ActionRow({
  action,
  now,
  selected,
  onSelect,
}: {
  action: ActionEntry;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("shell");
  const target = [action.projectName, action.serviceName].filter(Boolean).join("/");
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="flex w-full items-center gap-2.5 border-b px-4 py-2 text-left hover:bg-wash aria-pressed:bg-wash"
    >
      <StatusLamp status={lampFor(action)} label={t(`tape.status.${action.status}`)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{action.title}</span>
        {target && <span className="block truncate font-mono text-xs text-muted">{target}</span>}
      </span>
      <span className="font-mono text-xs text-muted">
        {formatElapsed(action.startedAt ?? action.createdAt, now)}
      </span>
    </button>
  );
}

function TapeDrawer({
  id,
  actions,
  now,
  selectedId,
  onSelect,
  onClose,
}: {
  id: string;
  actions: ActionEntry[];
  now: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("shell");
  const selected = actions.find((action) => action.id === selectedId);
  return (
    <section
      id={id}
      aria-label={t("tape.drawerLabel")}
      className="absolute inset-x-0 bottom-full z-40 h-[min(420px,56dvh)] animate-slide-in border-t bg-raised shadow-overlay"
    >
      {actions.length === 0 ? (
        <div className="flex h-full flex-col items-start justify-center gap-2 px-4 md:px-6">
          <p className="text-md font-medium">{t("tape.drawerEmptyTitle")}</p>
          <p className="max-w-[56ch] text-sm text-muted">{t("tape.drawerEmptyBody")}</p>
          <Link to="/activity" onClick={onClose} className="text-sm text-accent underline underline-offset-4">
            {t("tape.openActivity")}
          </Link>
        </div>
      ) : (
        <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[320px_minmax(0,1fr)] md:grid-rows-none">
          <div className="max-h-[132px] overflow-y-auto border-b md:max-h-none md:border-r md:border-b-0">
            {actions.map((action) => (
              <ActionRow
                key={action.id}
                action={action}
                now={now}
                selected={action.id === selectedId}
                onSelect={() => onSelect(action.id)}
              />
            ))}
          </div>
          <div className="min-h-0">
            {selected ? (
              selected.hasLog ? (
                <ActionLog key={selected.id} actionId={selected.id} />
              ) : (
                <p className="p-4 text-sm text-muted">{t("tape.noLog")}</p>
              )
            ) : (
              <p className="p-4 text-sm text-muted">{t("tape.pickAction")}</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

const drawerId = "activity-tape-drawer";

/** Running actions along the bottom edge, expanding into a live log. */
export function ActivityTape() {
  const { t } = useTranslation("shell");
  const actions = useTapeActions();
  const connection = useConnectionStatus();
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  const running = actions.filter(isActive);
  const hasElapsed = actions.length > 0;
  const now = useNow(hasElapsed);
  const current = running.at(-1) ?? actions.at(-1);
  const effectiveSelected =
    selectedId && actions.some((a) => a.id === selectedId) ? selectedId : (current?.id ?? null);

  useEffect(() => {
    if (!expanded) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        setExpanded(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  const connectionLabel =
    connection === "open" ? t("tape.connection.live") : t("tape.connection.reconnecting");

  return (
    <footer className="relative z-40 shrink-0 border-t bg-bg">
      {expanded && (
        <TapeDrawer
          id={drawerId}
          actions={actions}
          now={now}
          selectedId={effectiveSelected}
          onSelect={setSelectedId}
          onClose={() => setExpanded(false)}
        />
      )}
      <div aria-hidden="true" className="graduated pointer-events-none absolute inset-x-0 top-0 h-[5px]" />
      <button
        ref={toggle}
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={drawerId}
        className="group flex h-8 w-full items-center gap-3 px-4 text-left hover:bg-wash focus-visible:-outline-offset-2 md:px-6"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          {running.length > 0 && current ? (
            <>
              <StatusLamp status="busy" label={t("tape.status.running")} />
              <span className="shrink-0 font-mono text-xs">
                {t("tape.running", { count: running.length })}
              </span>
              <span aria-hidden="true" className="h-3 w-px shrink-0 bg-rule" />
              <span className="min-w-0 truncate text-xs">{current.title}</span>
              <span className="shrink-0 font-mono text-xs text-muted">
                {formatElapsed(current.startedAt ?? current.createdAt, now)}
              </span>
            </>
          ) : current ? (
            <>
              <StatusLamp status={lampFor(current)} label={t(`tape.status.${current.status}`)} />
              <span className="min-w-0 truncate text-xs">{current.title}</span>
            </>
          ) : (
            <>
              <StatusLamp status="off" label={t("tape.status.idle")} />
              <span className="min-w-0 truncate text-xs text-muted">{t("tape.idle")}</span>
            </>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-1.5">
            <StatusLamp status={connection === "open" ? "ok" : "busy"} label={connectionLabel} />
            <span aria-hidden="true" className="hidden text-xs text-muted sm:inline">
              {connectionLabel}
            </span>
          </span>
          <ChevronUp
            aria-hidden="true"
            className={cn(
              "size-3.5 text-muted transition-transform duration-[160ms] ease-out",
              expanded && "rotate-180",
            )}
          />
          <span className="sr-only">{expanded ? t("tape.collapse") : t("tape.expand")}</span>
        </span>
      </button>
    </footer>
  );
}
