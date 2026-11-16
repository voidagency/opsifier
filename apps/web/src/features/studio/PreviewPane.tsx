import type { ServiceStatus, StudioAppDetail } from "@opsifier/contract";
import { ExternalLink, Monitor, MousePointerClick, RotateCw, Smartphone, Tablet } from "lucide-react";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/forms";
import { Button, buttonClass, Lamp, Tooltip, toast } from "../../ui";
import { studioApi } from "./api";
import { readSelected, type SelectedElement } from "./selection";

type LampState = "running" | "stopped" | "progress" | "failed" | "unknown";
const lampOf: Record<ServiceStatus, LampState> = {
  running: "running",
  stopped: "stopped",
  starting: "progress",
  failing: "failed",
  undeployed: "stopped",
  unknown: "unknown",
};

export type Device = "desktop" | "tablet" | "mobile";
/** The width each device shows the page at: a common tablet's, and a common phone's. */
const DEVICE_WIDTHS: Record<Device, number | null> = { desktop: null, tablet: 768, mobile: 390 };
const DEVICE_ICONS = { desktop: Monitor, tablet: Tablet, mobile: Smartphone } as const;
/** The room left around a device's frame. */
const FRAME_MARGIN = 32;

const FROM_STUDIO = "opsifier-studio";
const FROM_PREVIEW = "opsifier-studio-preview";

function originOf(url: string | null): string | null {
  if (url === null) {
    return null;
  }
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function pathOf(url: string | null): string {
  if (url === null) {
    return "/";
  }
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
  } catch {
    return "/";
  }
}

/** The size of an element, followed as it changes. */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/**
 * The project's live preview: at a desktop's, a tablet's or a phone's width, with its address, and with
 * the inspector, when the page loads it, to point at one of its elements.
 */
export function PreviewPane({
  app,
  startRequested,
  onStartRequested,
  onStartFailed,
  onSelected,
  className,
}: {
  app: StudioAppDetail;
  startRequested: boolean;
  onStartRequested: () => void;
  /** The start asked for came to nothing: no more waiting for it. */
  onStartFailed: () => void;
  onSelected: (element: SelectedElement) => void;
  className?: string;
}) {
  const { t } = useTranslation(["studio", "common"]);
  const status = app.previewStatus;
  const origin = originOf(app.previewUrl);
  const [device, setDevice] = useState<Device>("desktop");
  const [frameKey, setFrameKey] = useState(0);
  const [source, setSource] = useState(app.previewUrl);
  const [path, setPath] = useState(pathOf(app.previewUrl));
  const [address, setAddress] = useState(path);
  // Read by the frame's messages as they come: what someone is typing is not replaced under them.
  const editing = useRef(false);
  const [inspectable, setInspectable] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const autoStarted = useRef(false);
  const [box, size] = useSize<HTMLDivElement>();

  const start = async () => {
    onStartRequested();
    try {
      const answer = await studioApi.startPreview(app.project, app.service);
      // Nothing was started, and nothing runs: there is nothing to wait for.
      if (!answer.started && status !== "running") {
        onStartFailed();
      }
    } catch (reason) {
      onStartFailed();
      toast.error(errorMessage(reason, t));
    }
  };

  // Opening a project starts its preview, as opening it in Lovable would, and builds it the first time:
  // whoever opens it may have no other way to, a designer least of all.
  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once per visit, on the first stopped state.
  useEffect(() => {
    if (!autoStarted.current && (status === "stopped" || status === "undeployed")) {
      autoStarted.current = true;
      void start();
    }
  }, [status]);

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      const data = event.data as {
        source?: unknown;
        type?: unknown;
        path?: unknown;
        element?: unknown;
      } | null;
      if (
        frame.current === null ||
        event.source !== frame.current.contentWindow ||
        event.origin !== origin ||
        data === null ||
        typeof data !== "object" ||
        data.source !== FROM_PREVIEW
      ) {
        return;
      }
      if ((data.type === "ready" || data.type === "location") && typeof data.path === "string") {
        if (data.type === "ready") {
          setInspectable(true);
        }
        setPath(data.path);
        setAddress((current) => (editing.current ? current : (data.path as string)));
      } else if (data.type === "selected") {
        const element = readSelected(data.element);
        setInspecting(false);
        if (element !== null) {
          onSelected(element);
        }
      } else if (data.type === "inspect-ended") {
        setInspecting(false);
      }
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [origin, onSelected]);

  const tell = (message: Record<string, unknown>) => {
    if (origin !== null) {
      frame.current?.contentWindow?.postMessage({ source: FROM_STUDIO, ...message }, origin);
    }
  };

  const reload = (to: string = path) => {
    if (origin === null) {
      return;
    }
    setInspectable(false);
    setInspecting(false);
    setSource(`${origin}${to.startsWith("/") ? to : `/${to}`}`);
    setFrameKey((key) => key + 1);
  };

  const toggleInspect = () => {
    const on = !inspecting;
    setInspecting(on);
    tell({ type: "inspect", on });
  };

  const showFrame = status === "running" && app.previewUrl !== null;
  const waiting = status === "starting" || (startRequested && status !== "running");
  const deviceWidth = DEVICE_WIDTHS[device];
  const scale =
    deviceWidth === null || size.width === 0 ? 1 : Math.min(1, (size.width - FRAME_MARGIN) / deviceWidth);
  const frameStyle: CSSProperties =
    deviceWidth === null
      ? { width: "100%", height: "100%" }
      : {
          width: deviceWidth,
          height: Math.max(0, (size.height - FRAME_MARGIN) / scale),
          transform: `scale(${scale})`,
          transformOrigin: "top center",
        };

  return (
    <section aria-label={t("preview.label")} className={cn("flex min-h-0 min-w-0 flex-col", className)}>
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
        <Lamp state={waiting ? "progress" : lampOf[status]} size="xs" decorative />
        <span className="shrink-0 text-muted">
          {t(waiting ? "preview.status.starting" : `preview.status.${status}`)}
        </span>
        {showFrame && (
          <>
            <fieldset className="flex shrink-0 items-center rounded-sm border p-0.5">
              <legend className="sr-only">{t("preview.device")}</legend>
              {(Object.keys(DEVICE_WIDTHS) as Device[]).map((option) => {
                const Icon = DEVICE_ICONS[option];
                return (
                  <Tooltip key={option} content={t(`preview.devices.${option}`)}>
                    <button
                      type="button"
                      aria-label={t(`preview.devices.${option}`)}
                      aria-pressed={device === option}
                      onClick={() => setDevice(option)}
                      className={cn(
                        "inline-flex size-6 items-center justify-center rounded-sm text-muted hover:text-ink",
                        device === option && "bg-wash text-ink",
                      )}
                    >
                      <Icon aria-hidden="true" className="size-3.5" />
                    </button>
                  </Tooltip>
                );
              })}
            </fieldset>
            <form
              className="min-w-[8rem] flex-1"
              onSubmit={(event) => {
                event.preventDefault();
                editing.current = false;
                reload(address.trim() === "" ? "/" : address.trim());
              }}
            >
              <input
                aria-label={t("preview.address")}
                value={address}
                onChange={(event) => {
                  // Typing again while the page reloads after Enter is typing all the same.
                  editing.current = true;
                  setAddress(event.target.value);
                }}
                onFocus={() => {
                  editing.current = true;
                }}
                onBlur={() => {
                  editing.current = false;
                }}
                onKeyDown={(event) => {
                  // As in a browser's address bar: Escape puts back the address of the page shown.
                  if (event.key === "Escape") {
                    setAddress(path);
                    event.currentTarget.blur();
                  }
                }}
                spellCheck={false}
                className="h-7 w-full rounded-sm border bg-raised px-2 font-mono text-xs text-ink"
              />
            </form>
            <Tooltip content={inspectable ? t("preview.inspect") : t("preview.inspectUnavailable")}>
              <Button
                size="icon-sm"
                variant={inspecting ? "primary" : "ghost"}
                aria-label={t("preview.inspect")}
                aria-pressed={inspecting}
                disabled={!inspectable}
                onClick={toggleInspect}
              >
                <MousePointerClick aria-hidden="true" className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip content={t("preview.reload")}>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("preview.reload")}
                onClick={() => reload()}
              >
                <RotateCw aria-hidden="true" className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip content={t("preview.open")}>
              <a
                href={origin === null ? undefined : `${origin}${path}`}
                target="_blank"
                rel="noreferrer"
                className={buttonClass("ghost", "icon-sm")}
                aria-label={t("preview.open")}
              >
                <ExternalLink aria-hidden="true" className="size-4" />
              </a>
            </Tooltip>
          </>
        )}
      </header>
      {inspecting && (
        <p className="border-b bg-wash px-3 py-1.5 text-xs text-muted">{t("preview.inspecting")}</p>
      )}
      <div ref={box} className="min-h-0 flex-1 overflow-hidden bg-wash">
        {showFrame ? (
          <div className={cn("flex h-full justify-center", deviceWidth !== null && "pt-4")}>
            <iframe
              ref={frame}
              key={frameKey}
              title={t("preview.frameTitle", { name: app.service })}
              src={source ?? undefined}
              style={frameStyle}
              onLoad={() => tell({ type: "ping" })}
              className={cn(
                "shrink-0 border-0 bg-white",
                deviceWidth !== null && "rounded-lg border shadow-lg",
              )}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            />
          </div>
        ) : (
          <div className="grid h-full place-items-center p-6">
            <div className="grid max-w-sm justify-items-center gap-3 text-center">
              <Lamp state={waiting ? "progress" : lampOf[status]} size="lg" decorative />
              <p className="font-medium">
                {waiting
                  ? t("preview.startingTitle")
                  : status === "running"
                    ? t("preview.noAddressTitle")
                    : t("preview.stoppedTitle")}
              </p>
              <p className="text-sm text-muted">
                {waiting
                  ? t("preview.startingDescription")
                  : status === "running"
                    ? t("preview.noAddressDescription")
                    : status === "undeployed"
                      ? t("preview.undeployedDescription")
                      : t("preview.stoppedDescription")}
              </p>
              {!waiting && status !== "running" && (
                <Button variant="primary" onClick={start}>
                  {t("preview.start")}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
