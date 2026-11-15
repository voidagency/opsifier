import type { StudioConversationStatus, StudioEvent } from "@opsifier/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { studioApi } from "./api";

/** While the agent works, its steps show within this. */
const BUSY_MS = 1500;
/** At rest, someone else's message on the same conversation still shows within this. */
const QUIET_MS = 5000;
const BUSY: ReadonlySet<StudioConversationStatus> = new Set(["running", "waiting", "unknown"]);

export interface ConversationState {
  events: StudioEvent[];
  status: StudioConversationStatus | null;
  title: string | null;
  error: unknown;
  loaded: boolean;
}

const EMPTY: ConversationState = { events: [], status: null, title: null, error: null, loaded: false };

/**
 * Follows one conversation: its events as they come, oldest first, and what the agent is doing. Asks
 * often while the agent works and seldom when it rests; `refresh` asks at once, after a message.
 */
export function useConversation(project: string, service: string, id: string | null) {
  const [state, setState] = useState<ConversationState>(EMPTY);
  const wake = useRef<() => void>(() => {});

  useEffect(() => {
    setState(EMPTY);
    if (id === null) {
      return;
    }
    let cursor: string | null = null;
    let stopped = false;
    let inFlight = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const poll = async (): Promise<void> => {
      if (stopped) {
        return;
      }
      if (inFlight) {
        again = true;
        return;
      }
      clearTimeout(timer);
      inFlight = true;
      let delay = QUIET_MS;
      try {
        const page = await studioApi.events(project, service, id, cursor, controller.signal);
        if (stopped) {
          return;
        }
        cursor = page.cursor;
        setState((current) => {
          const known = new Set(current.events.map((event) => event.id));
          return {
            events: [...current.events, ...page.items.filter((event) => !known.has(event.id))],
            status: page.status,
            title: page.title ?? current.title,
            error: null,
            loaded: true,
          };
        });
        delay = BUSY.has(page.status) || page.items.length > 0 ? BUSY_MS : QUIET_MS;
      } catch (error) {
        if (stopped) {
          return;
        }
        setState((current) => ({ ...current, error, loaded: true }));
      } finally {
        inFlight = false;
      }
      if (again) {
        again = false;
        void poll();
        return;
      }
      timer = setTimeout(() => void poll(), delay);
    };

    wake.current = () => void poll();
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
      wake.current = () => {};
    };
  }, [project, service, id]);

  const refresh = useCallback(() => wake.current(), []);
  return { ...state, refresh };
}
