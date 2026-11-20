import type { ServiceStatus, StudioAppDetail, StudioRemark, StudioViewing } from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import {
  ExternalLink,
  GitBranch,
  History,
  Link2,
  LoaderCircle,
  MessageSquareText,
  Monitor,
  MousePointerClick,
  PanelLeftOpen,
  RotateCcw,
  RotateCw,
  Smartphone,
  Tablet,
  TextCursorInput,
  Undo2,
  X,
} from "lucide-react";
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { formatDateTime } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import { Button, buttonClass, Lamp, Tooltip, toast } from "../../ui";
import { useCurrentUser } from "../auth/session";
import { studioApi, studioAppQuery } from "./api";
import { type Device, readSelected, readTextEdit, type SelectedElement, type TextEdit } from "./selection";
import { type ProjectSync, useProjectSync } from "./useProjectSync";

type LampState = "running" | "stopped" | "progress" | "failed" | "unknown";
/** What opening the project found on GitHub, when it is worth saying. */
function syncNotice(sync: ProjectSync, t: TFunction): string | null {
  if (sync.failed) {
    return t("preview.sync.failed");
  }
  const result = sync.result;
  switch (result?.state) {
    case undefined:
    case "current":
      return null;
    case "updated": {
      const brought = t("preview.sync.updated", { count: result.pulled, branch: result.branch });
      return result.previewRestarted ? `${brought} ${t("preview.sync.restarting")}` : brought;
    }
    case "blocked":
      return t("preview.sync.blocked", { count: result.behind, files: result.blocking.join(", ") });
    case "diverged":
      return t("preview.sync.diverged", { count: result.behind });
    case "ahead":
      return t("preview.sync.ahead", { count: result.ahead });
    case "deferred":
      return t("preview.sync.deferred", { count: result.behind });
    case "unavailable":
      // A folder that is no copy of a repository, or a project that waits for its own agent server,
      // has nothing to bring in yet: nothing to say.
      return result.reason === null || result.reason === "not_a_copy" || result.reason === "no_agent"
        ? null
        : t(`preview.sync.reasons.${result.reason}`, { branch: result.branch ?? "" });
  }
}

/** How soon the preview's state is read again after it was started again for new packages. */
const RESTART_CHECK_MS = 2_000;
/** How long the preview's server takes to read the files of another version, before the page loads again. */
const VERSION_RELOAD_MS = 1_500;

const lampOf: Record<ServiceStatus, LampState> = {
  running: "running",
  stopped: "stopped",
  starting: "progress",
  failing: "failed",
  undeployed: "stopped",
  unknown: "unknown",
};

export type { Device };

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

/** A page's path alone, without its query or fragment: a remark's pin is on the page whatever they say. */
function pageOf(path: string): string {
  try {
    return new URL(path, "https://preview.invalid").pathname;
  } catch {
    return path;
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

/** A request to show a remark on the preview: `nonce` asks again for the same one. */
export interface RemarkFocus {
  id: string;
  nonce: number;
}

/**
 * The project's live preview: at a desktop's, a tablet's or a phone's width, with its address, and with
 * the inspector, when the page loads it, to point at one of its elements and to pin its remarks.
 */
export function PreviewPane({
  app,
  startRequested,
  onStartRequested,
  onStartFailed,
  onSelected,
  onTextEdited,
  remarks,
  pinsOn,
  onTogglePins,
  focus,
  onRemarkClicked,
  onShare,
  chatHidden = false,
  onShowChat,
  viewing = null,
  versionBusy = false,
  onShowCurrent,
  onRestoreShown,
  className,
}: {
  app: StudioAppDetail;
  startRequested: boolean;
  onStartRequested: () => void;
  /** The start asked for came to nothing: no more waiting for it. */
  onStartFailed: () => void;
  onSelected: (element: SelectedElement) => void;
  /** A text the person changed where it is, in the page: for the next message. */
  onTextEdited: (edit: TextEdit) => void;
  /** The remarks to pin on the page, when the pins are on. */
  remarks: readonly StudioRemark[];
  pinsOn: boolean;
  onTogglePins: () => void;
  focus: RemarkFocus | null;
  /** Someone clicked a remark's pin on the page. */
  onRemarkClicked: (id: string) => void;
  /** Opens the links that show the preview to a client without an account. */
  onShare: () => void;
  /** The conversation is folded away on a wide screen: the preview offers it back. */
  chatHidden?: boolean;
  onShowChat?: () => void;
  /** An earlier version shown in place of the current one: the preview says so, and how to leave it. */
  viewing?: StudioViewing | null;
  versionBusy?: boolean;
  onShowCurrent?: () => void;
  /** Asks the agent to bring the version shown back, as a new one. */
  onRestoreShown?: () => void;
  className?: string;
}) {
  const { t, i18n } = useTranslation(["studio", "common"]);
  const me = useCurrentUser()?.email ?? null;
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
  // Changing a text where it is, in the page; it stays on across the page's own navigation.
  const [changingText, setChangingText] = useState(false);
  const changing = useRef(false);
  changing.current = changingText;
  const [inspecting, setInspecting] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  // Each page the frame loads says it is ready: its pins are sent again.
  const [loads, setLoads] = useState(0);
  // A remark to show once the page it is on has loaded.
  const pendingFocus = useRef<string | null>(null);
  const autoStarted = useRef(false);
  const [box, size] = useSize<HTMLDivElement>();
  // Only a project's own agent server brings its folder up to date: the shared one leaves it to its agent.
  const ownAgent = app.agentMode === "own";
  const sync = useProjectSync(app.project, app.service, ownAgent);
  const [noticeHidden, setNoticeHidden] = useState(false);
  // A new answer is told, even after the last one was put away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per answer.
  useEffect(() => {
    setNoticeHidden(false);
  }, [sync.result, sync.failed]);
  // New packages: the preview starts again to install them, which its lamp shows once read again.
  const queryClient = useQueryClient();
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per answer.
  useEffect(() => {
    if (!sync.result?.previewRestarted) {
      return;
    }
    const later = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: studioAppQuery(app.project, app.service).queryKey });
    }, RESTART_CHECK_MS);
    return () => clearTimeout(later);
  }, [sync.result]);
  // An earlier version is not on a branch, so nothing is brought from GitHub while it is shown: the
  // preview asks again once the current one is back.
  const notice = viewing === null ? syncNotice(sync, t) : null;
  const viewingSha = viewing?.sha ?? null;
  const shownVersion = useRef(viewingSha);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per version shown
  useEffect(() => {
    if (shownVersion.current === viewingSha) {
      return;
    }
    const wasViewing = shownVersion.current !== null;
    shownVersion.current = viewingSha;
    // The folder changed under the preview's server: the page is loaded again once it has read it.
    const later = setTimeout(() => reload(), VERSION_RELOAD_MS);
    if (wasViewing && viewingSha === null && ownAgent && sync.result?.reason === "detached") {
      sync.run();
    }
    return () => clearTimeout(later);
  }, [viewingSha]);

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
          setLoads((count) => count + 1);
          // A new page knows nothing of the mode: it is told again.
          if (changing.current) {
            frame.current.contentWindow?.postMessage(
              { source: FROM_STUDIO, type: "edit", on: true },
              origin ?? "*",
            );
          }
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
      } else if (data.type === "text-edited") {
        const edit = readTextEdit(data);
        if (edit !== null) {
          onTextEdited(edit);
        }
      } else if (data.type === "edit-ended") {
        setChangingText(false);
      } else if (data.type === "remark" && typeof (data as { id?: unknown }).id === "string") {
        onRemarkClicked((data as { id: string }).id);
      }
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [origin, onSelected, onTextEdited, onRemarkClicked]);

  const tell = (message: Record<string, unknown>) => {
    if (origin !== null) {
      frame.current?.contentWindow?.postMessage({ source: FROM_STUDIO, ...message }, origin);
    }
  };

  // What the page needs of each remark to pin it: no more. Sent again only when it changes.
  const pins = JSON.stringify(
    remarks.map((remark) => ({
      id: remark.id,
      number: remark.number,
      path: remark.path,
      selector: remark.element?.selector ?? "",
      point: remark.point,
      status: remark.status,
      text: remark.text,
      author: remark.author,
    })),
  );
  const openRemarks = remarks.filter((remark) => remark.status !== "done").length;

  // The page gets the pins whenever they change, and each time it loads; then the remark to show.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tell` reads the frame as it is now
  useEffect(() => {
    if (!inspectable) {
      return;
    }
    tell({ type: "remarks", items: pinsOn ? JSON.parse(pins) : [] });
    if (pendingFocus.current !== null) {
      tell({ type: "focus-remark", id: pendingFocus.current });
      pendingFocus.current = null;
    }
  }, [inspectable, pinsOn, pins, loads]);

  // A remark asked for is shown where it is: on the page shown, or once its own page has loaded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new request is a new nonce
  useEffect(() => {
    const remark = focus === null ? undefined : remarks.find((one) => one.id === focus.id);
    if (remark === undefined) {
      return;
    }
    if (pageOf(remark.path) === pageOf(path) && inspectable) {
      tell({ type: "focus-remark", id: remark.id });
    } else {
      pendingFocus.current = remark.id;
      reload(remark.path);
    }
  }, [focus?.nonce]);

  const reload = (to: string = path) => {
    if (origin === null) {
      return;
    }
    setInspectable(false);
    setInspecting(false);
    setChangingText(false);
    setSource(`${origin}${to.startsWith("/") ? to : `/${to}`}`);
    setFrameKey((key) => key + 1);
  };

  const toggleInspect = () => {
    const on = !inspecting;
    setInspecting(on);
    if (on) {
      setChangingText(false);
    }
    tell({ type: "inspect", on });
  };

  const toggleText = () => {
    const on = !changingText;
    setChangingText(on);
    if (on) {
      setInspecting(false);
    }
    tell({ type: "edit", on });
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
        {chatHidden && onShowChat !== undefined && (
          <Button
            size="icon-sm"
            variant="ghost"
            className="hidden lg:inline-flex"
            aria-label={t("panes.show")}
            tooltip={t("panes.show")}
            icon={<PanelLeftOpen aria-hidden="true" className="size-4" />}
            onClick={onShowChat}
          />
        )}
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
            <Tooltip content={inspectable ? t("preview.editText") : t("preview.inspectUnavailable")}>
              <Button
                size="icon-sm"
                variant={changingText ? "primary" : "ghost"}
                aria-label={t("preview.editText")}
                aria-pressed={changingText}
                disabled={!inspectable}
                onClick={toggleText}
              >
                <TextCursorInput aria-hidden="true" className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip
              content={
                !inspectable
                  ? t("preview.pinsUnavailable")
                  : pinsOn
                    ? t("preview.hidePins")
                    : t("preview.showPins")
              }
            >
              <button
                type="button"
                aria-label={t("preview.pins", { count: openRemarks })}
                aria-pressed={pinsOn}
                disabled={!inspectable}
                onClick={onTogglePins}
                className={cn(
                  buttonClass(pinsOn ? "secondary" : "ghost", "icon-sm"),
                  "relative disabled:opacity-45",
                )}
              >
                <MessageSquareText aria-hidden="true" className="size-4" />
                {openRemarks > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute -top-1 -right-1 min-w-4 rounded-full bg-[#f97316] px-1 text-center font-semibold text-[10px] text-white leading-4"
                  >
                    {openRemarks}
                  </span>
                )}
              </button>
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
        {ownAgent && (
          <Tooltip
            content={
              viewing !== null
                ? t("versions.noSync")
                : sync.syncing
                  ? t("preview.sync.running")
                  : sync.result?.state === "current"
                    ? t("preview.sync.current", { branch: sync.result.branch })
                    : t("preview.sync.action")
            }
          >
            <Button
              size="icon-sm"
              variant="ghost"
              className="ml-auto"
              aria-label={t("preview.sync.action")}
              aria-busy={sync.syncing}
              disabled={sync.syncing || viewing !== null}
              onClick={sync.run}
            >
              {sync.syncing ? (
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <GitBranch aria-hidden="true" className="size-4" />
              )}
            </Button>
          </Tooltip>
        )}
        <Button
          size="sm"
          variant="secondary"
          className={ownAgent ? undefined : "ml-auto"}
          icon={<Link2 aria-hidden="true" className="size-3.5" />}
          onClick={onShare}
        >
          {t("preview.share")}
        </Button>
      </header>
      {viewing !== null && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-accent/40 bg-accent/10 px-3 py-1.5 text-xs"
        >
          <History aria-hidden="true" className="size-3.5 shrink-0 text-accent" />
          <p className="min-w-0 flex-1 wrap-anywhere">
            {t(viewing.by !== null && viewing.by !== me ? "versions.bannerBy" : "versions.banner", {
              when: formatDateTime(viewing.at, i18n.language),
              // Still being shown, a version is known by its time only.
              subject: viewing.subject === "" ? t("versions.untitled") : viewing.subject,
              by: viewing.by ?? "",
            })}
          </p>
          {/* On a phone, the buttons go one under the other rather than past the screen's edge. */}
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {onShowCurrent !== undefined && (
              <Button
                size="sm"
                variant="secondary"
                pending={versionBusy}
                icon={<Undo2 aria-hidden="true" className="size-3.5" />}
                onClick={onShowCurrent}
              >
                {t("versions.back")}
              </Button>
            )}
            {onRestoreShown !== undefined && (
              <Button
                size="sm"
                variant="primary"
                disabledReason={versionBusy ? t("versions.blocked") : undefined}
                icon={<RotateCcw aria-hidden="true" className="size-3.5" />}
                onClick={onRestoreShown}
              >
                {t("versions.restoreThis")}
              </Button>
            )}
          </div>
        </div>
      )}
      {notice !== null && !noticeHidden && (
        <div role="status" className="flex items-start gap-2 border-b bg-wash px-3 py-1.5 text-xs text-muted">
          <GitBranch aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <p className="min-w-0 flex-1">{notice}</p>
          <button
            type="button"
            aria-label={t("preview.sync.dismiss")}
            onClick={() => setNoticeHidden(true)}
            className="shrink-0 rounded-sm text-muted hover:text-ink"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      )}
      {inspecting && (
        <p className="border-b bg-wash px-3 py-1.5 text-xs text-muted">{t("preview.inspecting")}</p>
      )}
      {changingText && (
        <p className="border-b bg-wash px-3 py-1.5 text-xs text-muted">{t("preview.editingText")}</p>
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
