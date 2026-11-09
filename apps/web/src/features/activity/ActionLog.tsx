import { type ActionStreamEvent, actionStreamEvent, actionTopic } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { useTopic } from "../../lib/realtime";
import { Skeleton } from "../../ui";
import { actionDetailQuery } from "./api";

/** An action's output: what was stored when it was opened, then every line streamed since. */
export function ActionLog({ actionId, className }: { actionId: string; className?: string }) {
  const { t } = useTranslation("shell");
  const [streamed, setStreamed] = useState<ReadonlyMap<number, string>>(new Map());
  const scroller = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  // Subscribed before the fetch begins, so a line written between the two cannot be missed.
  useTopic<unknown>(actionTopic(actionId), (payload) => {
    const event: ActionStreamEvent | undefined = actionStreamEvent.safeParse(payload).data;
    if (event?.kind === "log") {
      setStreamed((current) => new Map(current).set(event.seq, event.line));
    }
  });

  const { data, isPending, isError } = useQuery(actionDetailQuery(actionId));

  const text = useMemo(() => {
    const stored = data?.log ? data.log.replace(/\n$/, "").split("\n") : [];
    // Once an action has finished, the stored log is complete and nothing streamed can add to it.
    if (data !== undefined && data.status !== "queued" && data.status !== "running") {
      return stored.join("\n");
    }
    const covered = data?.logSeq ?? 0;
    const extra = [...streamed.entries()]
      .filter(([seq]) => seq > covered)
      .sort(([a], [b]) => a - b)
      .map(([, line]) => line);
    return [...stored, ...extra].join("\n");
  }, [data, streamed]);

  // Follow the end of the output unless the reader has scrolled up to look at something.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs whenever the text grows
  useEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [text]);

  if (isPending) {
    return (
      <div className="grid gap-2 p-4">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-3/5" />
      </div>
    );
  }

  if (isError) {
    return <p className="p-4 text-sm text-muted">{t("tape.logUnavailable")}</p>;
  }

  return (
    <pre
      ref={scroller}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: it scrolls, so the keyboard has to reach it
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
      className={cn("h-full overflow-auto p-4 font-mono text-xs whitespace-pre-wrap break-words", className)}
    >
      {text || <span className="text-muted">{t("tape.noOutput")}</span>}
    </pre>
  );
}
