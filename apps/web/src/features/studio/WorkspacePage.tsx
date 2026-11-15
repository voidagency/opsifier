import type { ServiceStatus, StudioAppDetail, StudioEvent, StudioModel } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  ArrowLeft,
  ExternalLink,
  Globe,
  ImagePlus,
  Lock,
  Plus,
  RotateCw,
  Send,
  Square,
  X,
} from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import {
  Button,
  buttonClass,
  EmptyState,
  ErrorState,
  Lamp,
  Markdown,
  Select,
  Skeleton,
  Textarea,
  Tooltip,
  toast,
} from "../../ui";
import { useCurrentUser } from "../auth/session";
import { servicesApi } from "../services/api";
import { studioApi, studioAppQuery, studioKey, studioModelsQuery } from "./api";
import { imageToDataUrl } from "./images";
import { useConversation } from "./useConversation";

const MAX_IMAGES = 4;
/** How often the preview's state is read while it starts, and otherwise. */
const STARTING_REFRESH_MS = 2000;
const IDLE_REFRESH_MS = 15_000;

type LampState = "running" | "stopped" | "progress" | "failed" | "unknown";

const lampOf: Record<ServiceStatus, LampState> = {
  running: "running",
  stopped: "stopped",
  starting: "progress",
  failing: "failed",
  undeployed: "stopped",
  unknown: "unknown",
};

/** The Studio of one project: its conversation with the agent on the left, its live preview on the right. */
export function WorkspacePage() {
  const { t } = useTranslation(["studio", "common"]);
  const user = useCurrentUser();
  const { project, service } = useParams({ strict: false }) as { project: string; service: string };
  const search = useSearch({ strict: false }) as { c?: string };
  const navigate = useNavigate();
  const [startRequested, setStartRequested] = useState(false);
  const { data, isPending, isError, error, refetch } = useQuery({
    ...studioAppQuery(project, service),
    enabled: user?.role === "admin",
    refetchInterval: (query) =>
      startRequested || query.state.data?.previewStatus === "starting"
        ? STARTING_REFRESH_MS
        : IDLE_REFRESH_MS,
  });

  useEffect(() => {
    if (startRequested && data?.previewStatus === "running") {
      setStartRequested(false);
    }
  }, [startRequested, data?.previewStatus]);

  if (user?.role !== "admin") {
    return (
      <EmptyState
        className="m-6"
        illustration="not-found"
        title={t("restricted.title")}
        description={t("restricted.description")}
      />
    );
  }
  if (isPending) {
    return <Skeleton className="m-6 h-[60vh]" />;
  }
  if (isError) {
    return <ErrorState className="m-6" message={errorMessage(error, t)} onRetry={() => refetch()} />;
  }

  const selected = search.c === "new" ? null : (search.c ?? data.conversations[0]?.id ?? null);
  const select = (id: string) =>
    navigate({ to: "/studio/$project/$service", params: { project, service }, search: { c: id } });

  return (
    <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(340px,440px)_minmax(0,1fr)] lg:grid-rows-1">
      <ConversationPane app={data} conversationId={selected} onSelect={select} />
      <PreviewPane
        app={data}
        startRequested={startRequested}
        onStartRequested={() => setStartRequested(true)}
      />
    </div>
  );
}

function ConversationPane({
  app,
  conversationId,
  onSelect,
}: {
  app: StudioAppDetail;
  conversationId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation(["studio", "common"]);
  const queryClient = useQueryClient();
  const conversation = useConversation(app.project, app.service, conversationId);
  const busy = conversation.status === "running" || conversation.status === "waiting";
  const [stopping, setStopping] = useState(false);
  const models = useQuery({ ...studioModelsQuery, enabled: conversationId === null });
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const nextProfile = chosenModel ?? models.data?.active ?? null;
  const nextModel =
    models.data?.models.find((model) => model.profile === nextProfile) ?? models.data?.models[0] ?? null;

  const stop = async () => {
    if (conversationId === null) {
      return;
    }
    setStopping(true);
    try {
      await studioApi.stop(app.project, app.service, conversationId);
      conversation.refresh();
    } catch (reason) {
      toast.error(errorMessage(reason, t));
    } finally {
      setStopping(false);
    }
  };

  const options = app.conversations.map((one) => ({
    value: one.id,
    label: one.title ?? new Date(one.createdAt).toLocaleString(),
  }));

  return (
    <section
      aria-label={t("conversation.label")}
      className="flex min-h-0 flex-col border-b lg:border-r lg:border-b-0"
    >
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Link to="/studio" className={buttonClass("ghost", "icon-sm")} aria-label={t("back")}>
          <ArrowLeft aria-hidden="true" className="size-4" />
        </Link>
        <h1 className="min-w-0 flex-1 truncate font-medium">{app.service}</h1>
        {options.length > 0 && conversationId !== null && (
          <Select
            aria-label={t("conversation.pick")}
            value={conversationId}
            onValueChange={onSelect}
            options={options}
            className="max-w-[45%]"
          />
        )}
        <Tooltip content={t("conversation.new")}>
          <Link
            to="/studio/$project/$service"
            params={{ project: app.project, service: app.service }}
            search={{ c: "new" }}
            className={buttonClass("ghost", "icon-sm")}
            aria-label={t("conversation.new")}
          >
            <Plus aria-hidden="true" className="size-4" />
          </Link>
        </Tooltip>
      </header>

      {conversationId === null && (models.data?.models.length ?? 0) > 1 && (
        <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
          <span className="shrink-0 text-muted">{t("model.pick")}</span>
          <Select
            aria-label={t("model.pick")}
            value={nextProfile ?? undefined}
            onValueChange={setChosenModel}
            options={(models.data?.models ?? []).flatMap((model) =>
              model.profile === null
                ? []
                : [
                    {
                      value: model.profile,
                      label: `${model.name} · ${model.private ? t("model.privateShort") : t("model.externalShort")}`,
                    },
                  ],
            )}
          />
        </div>
      )}
      {conversationId === null
        ? nextModel !== null && <ModelLine model={nextModel} />
        : conversation.model !== null && <ModelLine model={conversation.model} />}

      <EventList
        conversationId={conversationId}
        events={conversation.events}
        loaded={conversation.loaded}
        app={app}
      />

      {conversation.error !== null && (
        <p role="alert" className="border-t px-3 py-2 text-xs text-bad">
          {errorMessage(conversation.error, t)}
        </p>
      )}
      {busy && (
        <div className="flex items-center gap-2 border-t px-3 py-2 text-sm">
          <Lamp state="progress" size="xs" decorative />
          <span className="flex-1 text-muted">
            {conversation.status === "waiting" ? t("conversation.waiting") : t("conversation.working")}
          </span>
          <Button
            size="sm"
            variant="secondary"
            pending={stopping}
            icon={<Square aria-hidden="true" className="size-3.5" />}
            onClick={stop}
          >
            {t("conversation.stop")}
          </Button>
        </div>
      )}

      <Composer
        app={app}
        conversationId={conversationId}
        model={chosenModel}
        onSent={async (startedId) => {
          if (startedId !== null) {
            await queryClient.invalidateQueries({
              queryKey: [...studioKey, "apps", app.project, app.service],
            });
            onSelect(startedId);
          } else {
            conversation.refresh();
          }
        }}
      />
    </section>
  );
}

function EventList({
  app,
  conversationId,
  events,
  loaded,
}: {
  app: StudioAppDetail;
  conversationId: string | null;
  events: readonly StudioEvent[];
  loaded: boolean;
}) {
  const { t } = useTranslation(["studio", "common"]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const element = scroller.current;
    if (element !== null && pinned.current && events.length > 0) {
      element.scrollTop = element.scrollHeight;
    }
  }, [events]);

  return (
    <div
      ref={scroller}
      role="log"
      aria-live="polite"
      aria-label={t("conversation.messages")}
      // Scrolling with the keyboard needs the element to be focusable.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the conversation scrolls
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3"
    >
      {conversationId === null ? (
        <div className="grid gap-2 py-6 text-sm text-muted">
          <p className="font-medium text-ink">{t("conversation.emptyTitle", { name: app.service })}</p>
          <p>{t("conversation.emptyDescription")}</p>
        </div>
      ) : !loaded ? (
        <Skeleton className="h-24" />
      ) : (
        <ol className="grid gap-3">
          {events.map((event) => (
            <li key={event.id}>
              <EventItem event={event} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Which model the agent works with, and whether what it is sent stays on private addresses. */
function ModelLine({ model }: { model: StudioModel }) {
  const { t } = useTranslation("studio");
  const where = model.private
    ? t("model.private", { host: model.host ?? "" })
    : t("model.external", { host: model.host ?? t("model.unknownHost") });
  return (
    <p className="flex min-w-0 items-center gap-1.5 border-b px-3 py-1.5 text-xs text-muted">
      {model.private ? (
        <Lock aria-hidden="true" className="size-3.5 shrink-0 text-ok" />
      ) : (
        <Globe aria-hidden="true" className="size-3.5 shrink-0 text-busy" />
      )}
      <span className="sr-only">{t("model.label")}</span>
      <span className="shrink-0 font-medium text-ink">{model.name}</span>
      {model.profile !== null && <span className="shrink-0">· {model.profile}</span>}
      <span className="min-w-0 truncate">· {where}</span>
    </p>
  );
}

function EventItem({ event }: { event: StudioEvent }) {
  const { t } = useTranslation("studio");
  if (event.kind === "action") {
    return (
      <div className="grid gap-1">
        {event.thought !== null && <Markdown text={event.thought} />}
        <p className="flex min-w-0 items-baseline gap-2 text-xs text-muted">
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{event.described ? event.summary : t(`actions.${event.verb}`)}</span>
          {event.detail !== null && <code className="min-w-0 truncate font-mono">{event.detail}</code>}
        </p>
        {event.tasks !== null && event.tasks.length > 0 && (
          <ul className="grid gap-0.5 rounded-sm border px-2.5 py-1.5 text-xs" aria-label={t("tasks.label")}>
            {event.tasks.map((task) => (
              <li key={task.title} className="flex items-baseline gap-2">
                <span aria-hidden="true" className={task.status === "done" ? "text-ok" : "text-muted"}>
                  {task.status === "done" ? "✓" : task.status === "in_progress" ? "◐" : "○"}
                </span>
                <span className={task.status === "done" ? "text-muted line-through" : ""}>{task.title}</span>
                <span className="sr-only">{t(`tasks.${task.status}`)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (event.kind === "error") {
    return <p className="text-xs text-bad">{t("conversation.error", { message: event.text })}</p>;
  }
  const images =
    event.images.length === 0 ? null : (
      <div className="flex flex-wrap gap-1.5">
        {event.images.map((url) => (
          <img
            key={url.slice(-32)}
            src={url}
            alt={t("composer.imageAlt")}
            className="size-16 rounded-sm border object-cover"
          />
        ))}
      </div>
    );
  if (event.role === "user") {
    return (
      <div className="ml-auto grid max-w-[88%] gap-1.5 rounded-md bg-wash px-3 py-2">
        <span className="sr-only">{t("conversation.you")}</span>
        {event.text !== "" && <p className="whitespace-pre-wrap text-sm">{event.text}</p>}
        {images}
      </div>
    );
  }
  return (
    <div className="grid gap-1.5">
      <span className="eyebrow">{t("conversation.agent")}</span>
      <Markdown text={event.text} />
      {images}
    </div>
  );
}

function Composer({
  app,
  conversationId,
  model,
  onSent,
}: {
  app: StudioAppDetail;
  conversationId: string | null;
  /** The model profile chosen for a conversation being started, or null for the agent server's. */
  model: string | null;
  onSent: (startedId: string | null) => Promise<void>;
}) {
  const { t } = useTranslation(["studio", "common"]);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const addImages = async (files: readonly File[]) => {
    const room = MAX_IMAGES - images.length;
    const chosen = files.filter((file) => file.type.startsWith("image/")).slice(0, Math.max(0, room));
    if (files.length > room) {
      toast.error(t("composer.tooManyImages", { count: MAX_IMAGES }));
    }
    for (const file of chosen) {
      try {
        const url = await imageToDataUrl(file);
        setImages((current) => (current.length < MAX_IMAGES ? [...current, url] : current));
      } catch (reason) {
        toast.error(reason instanceof Error ? reason.message : t("composer.imageFailed"));
      }
    }
  };

  const send = async () => {
    if (sending || (text.trim() === "" && images.length === 0)) {
      return;
    }
    setSending(true);
    try {
      const body = { text, images };
      if (conversationId === null) {
        const started = await studioApi.start(app.project, app.service, {
          ...body,
          ...(model === null ? {} : { model }),
        });
        setText("");
        setImages([]);
        await onSent(started.id);
      } else {
        await studioApi.send(app.project, app.service, conversationId, body);
        setText("");
        setImages([]);
        await onSent(null);
      }
    } catch (reason) {
      toast.error(errorMessage(reason, t));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) {
      event.preventDefault();
      void addImages(files);
    }
  };

  return (
    <form
      className="grid gap-2 border-t p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {images.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t("composer.images")}>
          {images.map((url, index) => (
            <li key={url.slice(-32)} className="relative">
              <img
                src={url}
                alt={t("composer.imageAlt")}
                className="size-14 rounded-sm border object-cover"
              />
              <button
                type="button"
                className="absolute -top-1.5 -right-1.5 inline-flex size-5 items-center justify-center rounded-full border bg-raised text-muted hover:text-ink"
                aria-label={t("composer.removeImage", { number: index + 1 })}
                onClick={() => setImages((current) => current.filter((_, at) => at !== index))}
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Textarea
        aria-label={t("composer.label")}
        placeholder={conversationId === null ? t("composer.firstPlaceholder") : t("composer.placeholder")}
        value={text}
        rows={3}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="flex items-center justify-between gap-2">
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            void addImages([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          icon={<ImagePlus aria-hidden="true" className="size-4" />}
          onClick={() => fileInput.current?.click()}
        >
          {t("composer.attach")}
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          pending={sending}
          disabled={text.trim() === "" && images.length === 0}
          icon={<Send aria-hidden="true" className="size-4" />}
        >
          {t("composer.send")}
        </Button>
      </div>
    </form>
  );
}

function PreviewPane({
  app,
  startRequested,
  onStartRequested,
}: {
  app: StudioAppDetail;
  startRequested: boolean;
  onStartRequested: () => void;
}) {
  const { t } = useTranslation(["studio", "common"]);
  const [reloadKey, setReloadKey] = useState(0);
  const autoStarted = useRef(false);
  const status = app.previewStatus;

  const start = async () => {
    onStartRequested();
    try {
      await servicesApi.start(app.project, app.service);
    } catch (reason) {
      toast.error(errorMessage(reason, t));
    }
  };

  // Opening a project starts its preview, as opening it in Lovable would.
  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once per visit, on the first stopped state.
  useEffect(() => {
    if (!autoStarted.current && status === "stopped") {
      autoStarted.current = true;
      void start();
    }
  }, [status]);

  const showFrame = status === "running" && app.previewUrl !== null;
  const waiting = status === "starting" || (startRequested && status !== "running");

  return (
    <section aria-label={t("preview.label")} className="flex min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2 text-sm">
        <Lamp state={waiting ? "progress" : lampOf[status]} size="xs" decorative />
        <span className="shrink-0 text-muted">
          {t(waiting ? "preview.status.starting" : `preview.status.${status}`)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{app.previewUrl ?? ""}</span>
        {showFrame && (
          <>
            <Tooltip content={t("preview.reload")}>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("preview.reload")}
                onClick={() => setReloadKey((key) => key + 1)}
              >
                <RotateCw aria-hidden="true" className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip content={t("preview.open")}>
              <a
                href={app.previewUrl ?? undefined}
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
      <div className="min-h-0 flex-1 bg-wash">
        {showFrame ? (
          <iframe
            key={reloadKey}
            title={t("preview.frameTitle", { name: app.service })}
            src={app.previewUrl ?? undefined}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          />
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
              {!waiting && status !== "running" && status !== "undeployed" && (
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
