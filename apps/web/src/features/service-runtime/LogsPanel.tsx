import type { LogStreamFilter } from "@opsifier/contract";
import { Maximize2, Minus, Pause, Play, RotateCw } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Segmented, Select, Tooltip } from "../../ui";
import { FullscreenPanel } from "./FullscreenPanel";
import { LogSearch } from "./LogSearch";
import { LogLines, LogScope } from "./LogView";
import { filterLogView, type LogStore, type LogView, useServiceLogs } from "./logStore";

/** A filter over the live lines. It only narrows what is drawn, so it costs no memory of its own. */
export function useLogFilter(view: LogView) {
  const [text, setText] = useState("");
  const [stream, setStream] = useState<LogStreamFilter>("all");
  const shown = useMemo(() => filterLogView(view, { text, stream }), [view, text, stream]);
  return { shown, text, setText, stream, setStream, active: text.trim() !== "" || stream !== "all" };
}

interface LiveControlsProps {
  store: LogStore;
  view: LogView;
  filter: ReturnType<typeof useLogFilter>;
  /** Further buttons after the usual ones. */
  children?: ReactNode;
}

/** Filter, pause, separator and reload. On a phone the fields take their own rows. */
export function LiveControls({ store, view, filter, children }: LiveControlsProps) {
  const { t } = useTranslation("service-runtime");
  const pauseLabel = view.paused ? t("logs.resume") : t("logs.pause");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        mono
        value={filter.text}
        onChange={(event) => filter.setText(event.currentTarget.value)}
        maxLength={256}
        autoComplete="off"
        spellCheck={false}
        aria-label={t("logs.filter")}
        placeholder={t("logs.filterPlaceholder")}
        className="min-w-0 flex-1 basis-full sm:basis-52"
      />
      <div className="min-w-36 flex-1 sm:w-44 sm:flex-none">
        <Select
          aria-label={t("search.stream")}
          value={filter.stream}
          onValueChange={(next) => filter.setStream(next as LogStreamFilter)}
          options={(["all", "stdout", "stderr"] as const).map((value) => ({
            value,
            label: t(`search.streams.${value}`),
          }))}
        />
      </div>
      <div className="flex gap-1">
        <Tooltip content={pauseLabel}>
          <Button
            size="icon"
            variant="ghost"
            aria-label={pauseLabel}
            onClick={() => (view.paused ? store.resume() : store.pause())}
          >
            {view.paused ? (
              <Play aria-hidden="true" className="size-4" />
            ) : (
              <Pause aria-hidden="true" className="size-4" />
            )}
          </Button>
        </Tooltip>
        <Tooltip content={t("logs.separator")}>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("logs.separator")}
            onClick={() => store.addSeparator()}
          >
            <Minus aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
        <Tooltip content={t("logs.refresh")}>
          <Button size="icon" variant="ghost" aria-label={t("logs.refresh")} onClick={() => store.refresh()}>
            <RotateCw aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
        {children}
      </div>
    </div>
  );
}

interface LogsFullscreenProps {
  project: string;
  service: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Everything in here belongs to one service, so a change of service starts it all again. */
export function LogsFullscreen(props: LogsFullscreenProps) {
  return <LogsFullscreenFor key={`${props.project}/${props.service}`} {...props} />;
}

/** The live logs and the search over what Docker still holds, side by side in one window. */
function LogsFullscreenFor({ project, service, open, onOpenChange }: LogsFullscreenProps) {
  const { t } = useTranslation("service-runtime");
  const [mode, setMode] = useState<"live" | "search">("live");

  return (
    <FullscreenPanel
      open={open}
      onOpenChange={onOpenChange}
      title={t("logs.title", { service: `${project}/${service}` })}
      actions={
        <Segmented
          label={t("logs.modes.label")}
          value={mode}
          onChange={setMode}
          options={[
            { value: "live", label: t("logs.modes.live") },
            { value: "search", label: t("logs.modes.search") },
          ]}
        />
      }
    >
      {mode === "live" ? (
        <LiveLogs project={project} service={service} />
      ) : (
        <LogSearch project={project} service={service} />
      )}
    </FullscreenPanel>
  );
}

function LiveLogs({ project, service }: { project: string; service: string }) {
  const { store, view } = useServiceLogs(project, service);
  const filter = useLogFilter(view);
  return (
    <>
      <LogScope project={project} service={service} view={view} />
      <LiveControls store={store} view={view} filter={filter} />
      <LogLines
        view={filter.shown}
        name={`${project}_${service}`}
        className="min-h-0 flex-1"
        filtered={filter.active}
      />
    </>
  );
}

interface LogsPanelProps {
  project: string;
  service: string;
}

/** The logs of a service, of any type, with a way to read them full size. */
export function LogsPanel(props: LogsPanelProps) {
  return <LogsPanelFor key={`${props.project}/${props.service}`} {...props} />;
}

function LogsPanelFor({ project, service }: LogsPanelProps) {
  const { t } = useTranslation("service-runtime");
  const { store, view } = useServiceLogs(project, service);
  const filter = useLogFilter(view);
  const [fullscreen, setFullscreen] = useState(false);

  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 className="eyebrow">{t("logs.heading")}</h2>
        <LogScope project={project} service={service} view={view} />
      </div>
      <LiveControls store={store} view={view} filter={filter}>
        <Tooltip content={t("logs.fullscreen")}>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("logs.fullscreen")}
            onClick={() => setFullscreen(true)}
          >
            <Maximize2 aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
      </LiveControls>
      <LogLines
        view={filter.shown}
        name={`${project}_${service}`}
        className="h-[450px]"
        filtered={filter.active}
      />
      <LogsFullscreen project={project} service={service} open={fullscreen} onOpenChange={setFullscreen} />
    </section>
  );
}
