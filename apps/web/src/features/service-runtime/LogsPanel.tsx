import { Maximize2, Minus, RotateCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Segmented, Tooltip } from "../../ui";
import { FullscreenPanel } from "./FullscreenPanel";
import { LogSearch } from "./LogSearch";
import { LogLines } from "./LogView";
import { useServiceLogs } from "./logStore";

interface LogControlsProps {
  onSeparator: () => void;
  onRefresh: () => void;
}

function LogControls({ onSeparator, onRefresh }: LogControlsProps) {
  const { t } = useTranslation("service-runtime");
  return (
    <>
      <Tooltip content={t("logs.separator")}>
        <Button size="icon" variant="ghost" aria-label={t("logs.separator")} onClick={onSeparator}>
          <Minus aria-hidden="true" className="size-4" />
        </Button>
      </Tooltip>
      <Tooltip content={t("logs.refresh")}>
        <Button size="icon" variant="ghost" aria-label={t("logs.refresh")} onClick={onRefresh}>
          <RotateCw aria-hidden="true" className="size-4" />
        </Button>
      </Tooltip>
    </>
  );
}

interface LogsFullscreenProps {
  project: string;
  service: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The live logs and the search over what Docker still holds, side by side in one window. */
export function LogsFullscreen({ project, service, open, onOpenChange }: LogsFullscreenProps) {
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
  return (
    <>
      <div className="flex justify-end gap-1">
        <LogControls onSeparator={() => store.addSeparator()} onRefresh={() => store.refresh()} />
      </div>
      <LogLines view={view} name={`${project}_${service}`} className="min-h-0 flex-1" />
    </>
  );
}

interface LogsPanelProps {
  project: string;
  service: string;
}

/** The logs of a service, of any type, with a way to read them full size. */
export function LogsPanel({ project, service }: LogsPanelProps) {
  const { t } = useTranslation("service-runtime");
  const { store, view } = useServiceLogs(project, service);
  const [fullscreen, setFullscreen] = useState(false);

  return (
    <section className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="eyebrow">{t("logs.heading")}</h2>
        <div className="flex gap-1">
          <LogControls onSeparator={() => store.addSeparator()} onRefresh={() => store.refresh()} />
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
        </div>
      </div>
      <LogLines view={view} name={`${project}_${service}`} className="h-[360px]" />
      <LogsFullscreen project={project} service={service} open={fullscreen} onOpenChange={setFullscreen} />
    </section>
  );
}
