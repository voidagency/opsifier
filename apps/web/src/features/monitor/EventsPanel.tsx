import type { DockerEvent, DockerEventFrame } from "@opsifier/contract";
import { dockerEventFrame, dockerEventsTopic } from "@opsifier/contract";
import { Pause, Play, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatClock } from "../../lib/format";
import { useTopic } from "../../lib/realtime";
import {
  Button,
  countStates,
  Dialog,
  EmptyState,
  HealthSummary,
  Lamp,
  Pictogram,
  type PictogramName,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  type VisualState,
} from "../../ui";

const MAX_ROWS = 300;

const typePictograms: Readonly<Record<string, PictogramName>> = {
  container: "deployment",
  image: "image",
  network: "network",
  volume: "volume",
  service: "deployment",
  node: "node",
  secret: "access",
  config: "settings",
};

/** Problems first and quiet things last, like every other list in the panel. */
function eventState(event: DockerEvent): VisualState {
  const action = event.action.split(":", 1)[0] ?? "";
  if (action === "oom") {
    return "failed";
  }
  if (action === "die") {
    return event.attributes.exitCode === "0" ? "stopped" : "failed";
  }
  if (action === "kill") {
    return "stopped";
  }
  if (["health_status"].includes(action)) {
    return event.action.includes("unhealthy") ? "degraded" : "running";
  }
  if (["stop", "destroy", "remove", "delete", "disconnect", "unmount", "untag"].includes(action)) {
    return "stopped";
  }
  if (
    ["create", "start", "restart", "update", "pull", "tag", "connect", "mount", "attach"].includes(action)
  ) {
    return "running";
  }
  return "unknown";
}

function EventRow({ event, onDetails }: { event: DockerEvent; onDetails: () => void }) {
  const { t, i18n } = useTranslation("monitor");
  const state = eventState(event);
  return (
    <TR>
      <TD className="w-44">
        <span className="flex items-center gap-2">
          <Lamp state={state} size="xs" still decorative />
          <Pictogram name={typePictograms[event.type] ?? "settings"} size={16} />
          <span className="capitalize">{event.type}</span>
        </span>
      </TD>
      <TD mono>{event.action}</TD>
      <TD mono numeric className="w-36">
        {formatClock(event.at, i18n.language)}
      </TD>
      <TD className="w-16 text-right">
        <Button size="sm" variant="ghost" onClick={onDetails}>
          {t("events.details")}
        </Button>
      </TD>
    </TR>
  );
}

/** Live events from the Docker daemon. Paused events are dropped, as the header says. */
export function EventsPanel() {
  const { t } = useTranslation(["monitor", "common"]);
  const [events, setEvents] = useState<DockerEvent[]>([]);
  const [available, setAvailable] = useState(true);
  const [paused, setPaused] = useState(false);
  const [selected, setSelected] = useState<VisualState | null>(null);
  const [details, setDetails] = useState<DockerEvent | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useTopic<DockerEventFrame>(dockerEventsTopic, (payload) => {
    const parsed = dockerEventFrame.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const frame = parsed.data;
    if (frame.kind === "snapshot") {
      setAvailable(frame.available);
      if (!pausedRef.current) {
        setEvents([...frame.events].reverse().slice(0, MAX_ROWS));
      }
      return;
    }
    if (frame.kind === "state") {
      setAvailable(frame.available);
      return;
    }
    if (!pausedRef.current) {
      setEvents((current) => [frame.event, ...current].slice(0, MAX_ROWS));
    }
  });

  const counts = useMemo(() => countStates(events.map(eventState)), [events]);
  const shown = selected === null ? events : events.filter((event) => eventState(event) === selected);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <HealthSummary counts={counts} variant="row" selected={selected} onSelect={setSelected} />
        <div className="flex gap-2">
          <Button
            icon={
              paused ? (
                <Play aria-hidden="true" className="size-4" />
              ) : (
                <Pause aria-hidden="true" className="size-4" />
              )
            }
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? t("events.resume") : t("events.pause")}
          </Button>
          <Button icon={<Trash2 aria-hidden="true" className="size-4" />} onClick={() => setEvents([])}>
            {t("events.clear")}
          </Button>
        </div>
      </div>
      {!available && <Lamp state="failed" showLabel label={t("events.unavailable")} />}
      {events.length === 0 ? (
        <EmptyState
          illustration="no-activity"
          title={t("events.emptyTitle")}
          description={t("events.emptyDescription")}
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>{t("events.type")}</TH>
              <TH>{t("events.action")}</TH>
              <TH numeric>{t("events.time")}</TH>
              <TH className="text-right">
                <span className="sr-only">{t("events.details")}</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {shown.map((event) => (
              <EventRow key={event.seq} event={event} onDetails={() => setDetails(event)} />
            ))}
          </TBody>
        </Table>
      )}
      <Dialog
        open={details !== null}
        onOpenChange={(open) => !open && setDetails(null)}
        title={t("events.detailsTitle")}
        size="lg"
        footer={<Button onClick={() => setDetails(null)}>{t("common:actions.close")}</Button>}
      >
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: it scrolls, so the keyboard has to reach it */}
        <pre tabIndex={0} className="overflow-auto rounded-sm bg-raised p-3 font-mono text-xs">
          {details === null ? "" : JSON.stringify({ ...details, seq: undefined }, null, 2)}
        </pre>
      </Dialog>
    </div>
  );
}
