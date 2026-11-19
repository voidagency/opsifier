import { type KeyboardEvent, type RefObject, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/** The conversation's width beside the preview on a wide screen, in pixels. */
export const CHAT_WIDTH = { min: 320, max: 720, initial: 440, step: 16 } as const;
/** What the preview keeps beside the conversation, however wide it is dragged. */
const MIN_PREVIEW_WIDTH = 360;
const STORAGE_KEY = "opsifier.studio.chat-panel";

interface ChatPanel {
  width: number;
  collapsed: boolean;
}

/** A width within bounds, leaving the preview its share of `room`, the workspace's width, when known. */
export function clampChatWidth(width: number, room: number | null): number {
  const max =
    room === null || room <= 0
      ? CHAT_WIDTH.max
      : Math.min(CHAT_WIDTH.max, Math.max(CHAT_WIDTH.min, room - MIN_PREVIEW_WIDTH));
  return Math.round(Math.min(max, Math.max(CHAT_WIDTH.min, width)));
}

function readSaved(): ChatPanel {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof saved === "object" && saved !== null) {
      const { width, collapsed } = saved as Record<string, unknown>;
      return {
        width:
          typeof width === "number" && Number.isFinite(width)
            ? clampChatWidth(width, null)
            : CHAT_WIDTH.initial,
        collapsed: collapsed === true,
      };
    }
  } catch {
    // A browser that keeps nothing starts from the defaults.
  }
  return { width: CHAT_WIDTH.initial, collapsed: false };
}

/**
 * How the conversation sits beside the preview on a wide screen: its width, and whether it is folded
 * away for the preview to take the whole width. Kept in this browser, for the next visit.
 */
export function useChatPanel() {
  const [panel, setPanel] = useState<ChatPanel>(readSaved);
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(panel));
    } catch {
      // Kept for this visit only.
    }
  }, [panel]);
  const setWidth = useCallback(
    (width: number, room: number | null) =>
      setPanel((current) => {
        const next = clampChatWidth(width, room);
        return next === current.width ? current : { ...current, width: next };
      }),
    [],
  );
  const setCollapsed = useCallback(
    (collapsed: boolean) =>
      setPanel((current) => (current.collapsed === collapsed ? current : { ...current, collapsed })),
    [],
  );
  return { ...panel, setWidth, setCollapsed };
}

/**
 * The border between the conversation and the preview, which a person drags, or moves with the arrow
 * keys once focused. A double click puts it back where it starts.
 */
export function ChatResizer({
  width,
  workspace,
  onWidth,
}: {
  width: number;
  /** The workspace both panes share, which the width is measured from. */
  workspace: RefObject<HTMLElement | null>;
  onWidth: (width: number, room: number | null) => void;
}) {
  const { t } = useTranslation("studio");
  const [dragging, setDragging] = useState(false);
  const room = useCallback(() => workspace.current?.getBoundingClientRect().width ?? null, [workspace]);

  useEffect(() => {
    if (!dragging) {
      return;
    }
    const move = (event: PointerEvent) => {
      const left = workspace.current?.getBoundingClientRect().left ?? 0;
      onWidth(event.clientX - left, room());
    };
    const end = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [dragging, onWidth, room, workspace]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? CHAT_WIDTH.step * 4 : CHAT_WIDTH.step;
    const next =
      event.key === "ArrowLeft"
        ? width - step
        : event.key === "ArrowRight"
          ? width + step
          : event.key === "Home"
            ? CHAT_WIDTH.min
            : event.key === "End"
              ? CHAT_WIDTH.max
              : null;
    if (next !== null) {
      event.preventDefault();
      onWidth(next, room());
    }
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be dragged or take the arrow keys */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("panes.resize")}
        aria-valuemin={CHAT_WIDTH.min}
        aria-valuemax={CHAT_WIDTH.max}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button === 0) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDoubleClick={() => onWidth(CHAT_WIDTH.initial, room())}
        onKeyDown={onKeyDown}
        style={{ left: width }}
        className="absolute inset-y-0 z-10 hidden w-2 -translate-x-1/2 cursor-col-resize touch-none hover:bg-accent/30 focus-visible:bg-accent/40 focus-visible:outline-none lg:block"
      />
      {/* While it is dragged, the preview's frame would take the pointer away: a veil keeps it here. */}
      {dragging && <div aria-hidden="true" className="fixed inset-0 z-50 cursor-col-resize" />}
    </>
  );
}
