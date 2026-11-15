import type { StudioAppDetail, StudioEvent, StudioModel } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  Globe,
  ImagePlus,
  Lock,
  MousePointerClick,
  Plus,
  Sparkles,
  Square,
  Users,
  X,
} from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/forms";
import {
  Button,
  buttonClass,
  ErrorState,
  Lamp,
  Markdown,
  Segmented,
  Select,
  Skeleton,
  Tooltip,
  toast,
} from "../../ui";
import { useCurrentUser } from "../auth/session";
import { studioApi, studioAppQuery, studioKey, studioModelsQuery } from "./api";
import { type ChatItem, changedFiles, type StudioActionEvent, toChatItems, userMessageCount } from "./chat";
import { imageToDataUrl } from "./images";
import { PreviewPane } from "./PreviewPane";
import { ShareDialog } from "./ShareDialog";
import { elementBlock, elementLabel, type SelectedElement, splitMessage } from "./selection";
import { useConversation } from "./useConversation";

const MAX_IMAGES = 4;
/** How often the preview's state is read while it starts, and otherwise. */
const STARTING_REFRESH_MS = 2000;
const IDLE_REFRESH_MS = 15_000;
const STARTERS = ["design", "mobile", "texts"] as const;
/** The message field grows with what is typed, up to this height, then scrolls. */
const COMPOSER_MAX_HEIGHT = 192;
/** Closer than this to the end, the conversation follows what arrives. */
const FOLLOW_DISTANCE = 48;

/** A message on its way: shown at once, until the conversation has it. */
interface PendingMessage {
  /** The conversation it goes to; null while a new one starts. */
  conversationId: string | null;
  text: string;
  images: string[];
  /** How many messages the person had sent in that conversation before this one. */
  sentBefore: number;
}

/** The Studio of one project: its conversation with the agent on the left, its live preview on the right. */
export function WorkspacePage() {
  const { t } = useTranslation(["studio", "common"]);
  const user = useCurrentUser();
  const { project, service } = useParams({ strict: false }) as { project: string; service: string };
  const search = useSearch({ strict: false }) as { c?: string };
  const navigate = useNavigate();
  const [startRequested, setStartRequested] = useState(false);
  const [element, setElement] = useState<SelectedElement | null>(null);
  // A phone shows one pane at a time, at full height; a wide screen shows both.
  const [pane, setPane] = useState<"chat" | "preview">("chat");
  const { data, isPending, isError, error, refetch } = useQuery({
    ...studioAppQuery(project, service),
    enabled: user !== null && user !== undefined,
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
    <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[minmax(340px,440px)_minmax(0,1fr)] lg:grid-rows-1">
      <div className="flex items-center justify-center border-b px-3 py-1.5 lg:hidden">
        <Segmented
          label={t("panes.label")}
          value={pane}
          onChange={setPane}
          options={[
            { value: "chat", label: t("panes.chat") },
            { value: "preview", label: t("panes.preview") },
          ]}
        />
      </div>
      <ConversationPane
        className={pane === "chat" ? undefined : "hidden lg:flex"}
        app={data}
        conversationId={selected}
        onSelect={select}
        element={element}
        onClearElement={() => setElement(null)}
      />
      <PreviewPane
        // Hidden rather than taken away on a phone, so that the preview keeps its page.
        className={pane === "preview" ? undefined : "hidden lg:flex"}
        app={data}
        startRequested={startRequested}
        onStartRequested={() => setStartRequested(true)}
        onSelected={(selection) => {
          setElement(selection);
          // On a phone, the element pointed at is the start of a message: back to the conversation.
          setPane("chat");
        }}
      />
    </div>
  );
}

function ConversationPane({
  app,
  conversationId,
  onSelect,
  element,
  onClearElement,
  className,
}: {
  app: StudioAppDetail;
  conversationId: string | null;
  onSelect: (id: string) => void;
  element: SelectedElement | null;
  onClearElement: () => void;
  className?: string;
}) {
  const { t } = useTranslation(["studio", "common"]);
  const queryClient = useQueryClient();
  const conversation = useConversation(app.project, app.service, conversationId);
  const busy = conversation.status === "running" || conversation.status === "waiting";
  const [stopping, setStopping] = useState(false);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const admin = useCurrentUser()?.role === "admin";
  const [sharing, setSharing] = useState(false);
  const models = useQuery({ ...studioModelsQuery, enabled: conversationId === null });
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  const nextProfile = chosenModel ?? models.data?.active ?? null;
  const nextModel =
    models.data?.models.find((model) => model.profile === nextProfile) ?? models.data?.models[0] ?? null;

  // The message being sent goes once the conversation shows it.
  useEffect(() => {
    if (
      pending !== null &&
      pending.conversationId === conversationId &&
      conversationId !== null &&
      userMessageCount(conversation.events) > pending.sentBefore
    ) {
      setPending(null);
    }
  }, [pending, conversationId, conversation.events]);

  /** Sends what was typed, with the element pointed at in the preview, to a new conversation or this one. */
  const send = async (text: string, images: string[]): Promise<boolean> => {
    if (sending) {
      return false;
    }
    const full = element === null ? text : `${text.trim()}\n\n${elementBlock(element)}`.trim();
    setSending(true);
    setPending({
      conversationId,
      text: full,
      images,
      sentBefore: conversationId === null ? 0 : userMessageCount(conversation.events),
    });
    try {
      if (conversationId === null) {
        const started = await studioApi.start(app.project, app.service, {
          text: full,
          images,
          ...(chosenModel === null ? {} : { model: chosenModel }),
        });
        await queryClient.invalidateQueries({ queryKey: [...studioKey, "apps", app.project, app.service] });
        // The message follows into the conversation it started.
        setPending((current) => (current === null ? null : { ...current, conversationId: started.id }));
        onSelect(started.id);
      } else {
        await studioApi.send(app.project, app.service, conversationId, { text: full, images });
        conversation.refresh();
      }
      onClearElement();
      return true;
    } catch (reason) {
      setPending(null);
      toast.error(errorMessage(reason, t));
      return false;
    } finally {
      setSending(false);
    }
  };

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

  // The agent's suggestions follow its last word, while it waits for the next request.
  const lastMessage = [...conversation.events].reverse().find((event) => event.kind === "message");
  const suggestions =
    pending !== null
      ? []
      : conversationId === null
        ? STARTERS.map((key) => t(`suggestions.starters.${key}`))
        : !busy && lastMessage?.kind === "message" && lastMessage.role === "agent"
          ? lastMessage.suggestions
          : [];

  return (
    <section
      aria-label={t("conversation.label")}
      className={cn("flex min-h-0 min-w-0 flex-col lg:border-r", className)}
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
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
        {admin && (
          <Tooltip content={t("share.action")}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("share.action")}
              icon={<Users aria-hidden="true" className="size-4" />}
              onClick={() => setSharing(true)}
            />
          </Tooltip>
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
        <div className="flex min-w-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
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
        key={conversationId ?? "new"}
        app={app}
        conversationId={conversationId}
        events={conversation.events}
        loaded={conversation.loaded}
        busy={busy}
        waiting={conversation.status === "waiting"}
        pending={pending !== null && pending.conversationId === conversationId ? pending : null}
      />

      {conversation.error !== null && (
        <p role="alert" className="border-t px-3 py-2 text-xs text-bad wrap-anywhere">
          {errorMessage(conversation.error, t)}
        </p>
      )}

      {suggestions.length > 0 && (
        <ul aria-label={t("suggestions.label")} className="flex flex-wrap gap-1.5 px-3 pt-2.5">
          {suggestions.map((suggestion) => (
            <li key={suggestion} className="min-w-0 max-w-full">
              <button
                type="button"
                disabled={sending}
                onClick={() => void send(suggestion, [])}
                className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-raised px-2.5 py-1 text-left text-xs hover:border-accent hover:text-ink disabled:opacity-45"
              >
                <Sparkles aria-hidden="true" className="size-3 shrink-0 text-accent" />
                <span className="min-w-0 wrap-anywhere">{suggestion}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {sharing && (
        <ShareDialog project={app.project} service={app.service} onClose={() => setSharing(false)} />
      )}

      <Composer
        firstMessage={conversationId === null}
        sending={sending}
        busy={busy}
        stopping={stopping}
        element={element}
        onClearElement={onClearElement}
        onSend={send}
        onStop={stop}
      />
    </section>
  );
}

function EventList({
  app,
  conversationId,
  events,
  loaded,
  busy,
  waiting,
  pending,
}: {
  app: StudioAppDetail;
  conversationId: string | null;
  events: readonly StudioEvent[];
  loaded: boolean;
  busy: boolean;
  waiting: boolean;
  pending: PendingMessage | null;
}) {
  const { t } = useTranslation(["studio", "common"]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [behind, setBehind] = useState(false);
  // Groups of steps the person opened or closed; the others follow whether the agent is still on them.
  const [toggled, setToggled] = useState<Readonly<Record<string, boolean>>>({});
  const items = toChatItems(events);

  const toEnd = useCallback(() => {
    const element = scroller.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
    following.current = true;
    setBehind(false);
  }, []);

  // Whatever makes the conversation taller, new events, an image that loads or a group that opens,
  // keeps it at its end while the person is there, and says so when they read further up.
  useEffect(() => {
    const element = content.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (following.current) {
        toEnd();
      } else {
        setBehind(true);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [toEnd]);

  // Where nothing reports a size, as in tests, the end is followed on each new event.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when what is shown changes
  useEffect(() => {
    if (following.current) {
      toEnd();
    }
  }, [events.length, busy, toEnd]);

  // A message just sent is followed, wherever the person was.
  useEffect(() => {
    if (pending !== null) {
      toEnd();
    }
  }, [pending, toEnd]);

  const isEmpty = conversationId === null && pending === null;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
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
          following.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_DISTANCE;
          if (following.current) {
            setBehind(false);
          }
        }}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-4"
      >
        <div ref={content} className="grid grid-cols-1 gap-4">
          {isEmpty ? (
            <div className="grid gap-2 py-6 text-sm text-muted">
              <p className="font-medium text-ink">{t("conversation.emptyTitle", { name: app.service })}</p>
              <p>{t("conversation.emptyDescription")}</p>
            </div>
          ) : conversationId !== null && !loaded && pending === null ? (
            <Skeleton className="h-24" />
          ) : (
            <ol className="grid grid-cols-1 gap-4">
              {items.map((item, index) => {
                const live = busy && item.kind === "work" && index === items.length - 1;
                return (
                  <li key={item.kind === "work" ? `work-${item.id}` : item.event.id} className="min-w-0">
                    {item.kind === "work" ? (
                      <WorkGroup
                        steps={item.steps}
                        live={live}
                        open={toggled[item.id] ?? live}
                        onToggle={() =>
                          setToggled((current) => ({ ...current, [item.id]: !(current[item.id] ?? live) }))
                        }
                      />
                    ) : (
                      <ChatEntry item={item} />
                    )}
                  </li>
                );
              })}
              {pending !== null && (
                <li className="min-w-0">
                  <UserMessage text={pending.text} images={pending.images} sending />
                </li>
              )}
              {busy && (
                <li className="flex items-center gap-2 text-xs text-muted">
                  <Lamp state="progress" size="xs" decorative />
                  {waiting ? t("conversation.waiting") : t("conversation.working")}
                </li>
              )}
            </ol>
          )}
        </div>
      </div>
      {behind && (
        <button
          type="button"
          onClick={toEnd}
          className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-raised px-3 py-1 text-xs shadow-overlay hover:text-ink"
        >
          <ArrowDown aria-hidden="true" className="size-3.5" />
          {t("conversation.latest")}
        </button>
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

function ElementChip({ label, onRemove }: { label: string; onRemove?: () => void }) {
  const { t } = useTranslation("studio");
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-sm border border-accent/40 bg-raised px-2 py-0.5 text-xs">
      <MousePointerClick aria-hidden="true" className="size-3.5 shrink-0 text-accent" />
      <span className="sr-only">{t("element.label")}</span>
      <span className="min-w-0 truncate font-mono">{label}</span>
      {onRemove !== undefined && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("element.remove")}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted hover:text-ink"
        >
          <X aria-hidden="true" className="size-3" />
        </button>
      )}
    </span>
  );
}

function ChatEntry({ item }: { item: Exclude<ChatItem, { kind: "work" }> }) {
  const { t } = useTranslation("studio");
  if (item.kind === "error") {
    return (
      <p className="text-xs text-bad wrap-anywhere">
        {t("conversation.error", { message: item.event.text })}
      </p>
    );
  }
  if (item.event.role === "user") {
    return <UserMessage text={item.event.text} images={item.event.images} />;
  }
  return (
    <div className="grid grid-cols-1 gap-1.5">
      <span className="sr-only">{t("conversation.agent")}</span>
      <Markdown text={item.event.text} />
      <Images urls={item.event.images} />
    </div>
  );
}

function Images({ urls }: { urls: readonly string[] }) {
  const { t } = useTranslation("studio");
  if (urls.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {urls.map((url) => (
        <img
          key={url.slice(-32)}
          src={url}
          alt={t("composer.imageAlt")}
          className="size-16 rounded-sm border object-cover"
        />
      ))}
    </div>
  );
}

/** What the person wrote, on the right, with the elements it points at as tags. */
function UserMessage({
  text,
  images,
  sending = false,
}: {
  text: string;
  images: readonly string[];
  sending?: boolean;
}) {
  const { t } = useTranslation("studio");
  const parts = splitMessage(text);
  return (
    <div
      className={cn(
        "ml-auto grid w-fit min-w-0 max-w-[88%] grid-cols-1 gap-1.5 rounded-md bg-wash px-3 py-2",
        sending && "opacity-70",
      )}
    >
      <span className="sr-only">{t("conversation.you")}</span>
      {parts.elements.map((label) => (
        <span key={label} className="min-w-0">
          <ElementChip label={label} />
        </span>
      ))}
      {parts.text !== "" && <p className="whitespace-pre-wrap text-sm wrap-anywhere">{parts.text}</p>}
      <Images urls={images} />
      {sending && <span className="text-xs text-muted">{t("conversation.sending")}</span>}
    </div>
  );
}

/**
 * A stretch of the agent's work: what it said as it went, and one line for each step. It stays open
 * while the agent is on it, and folds into one line once the agent has answered.
 */
function WorkGroup({
  steps,
  live,
  open,
  onToggle,
}: {
  steps: readonly StudioActionEvent[];
  live: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("studio");
  const listId = useId();
  const files = changedFiles(steps).length;
  return (
    <div className="grid grid-cols-1 gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={onToggle}
        className="-mx-1 inline-flex min-w-0 max-w-full items-center gap-1.5 justify-self-start rounded-sm px-1 py-0.5 text-xs text-muted hover:bg-wash hover:text-ink"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 transition-transform duration-[120ms]", open && "rotate-90")}
        />
        {live && <Lamp state="progress" size="xs" decorative />}
        <span className="min-w-0 truncate">
          {t("work.steps", { count: steps.length })}
          {files > 0 && ` · ${t("work.files", { count: files })}`}
        </span>
      </button>
      {open && (
        <ol id={listId} className="ml-1.5 grid grid-cols-1 gap-2.5 border-l pl-3">
          {steps.map((step) => (
            <li key={step.id} className="min-w-0">
              <Step step={step} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Step({ step }: { step: StudioActionEvent }) {
  const { t } = useTranslation("studio");
  return (
    <div className="grid grid-cols-1 gap-1">
      {step.thought !== null && <Markdown text={step.thought} />}
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted">
        <span className="min-w-0 wrap-anywhere">
          {step.described ? step.summary : t(`actions.${step.verb}`)}
        </span>
        {step.detail !== null && <code className="min-w-0 max-w-full truncate font-mono">{step.detail}</code>}
      </p>
      {step.tasks !== null && step.tasks.length > 0 && (
        <ul className="grid gap-0.5 rounded-sm border px-2.5 py-1.5 text-xs" aria-label={t("tasks.label")}>
          {step.tasks.map((task) => (
            <li key={task.title} className="flex min-w-0 items-baseline gap-2">
              <span aria-hidden="true" className={task.status === "done" ? "text-ok" : "text-muted"}>
                {task.status === "done" ? "✓" : task.status === "in_progress" ? "◐" : "○"}
              </span>
              <span
                className={cn("min-w-0 wrap-anywhere", task.status === "done" && "text-muted line-through")}
              >
                {task.title}
              </span>
              <span className="sr-only">{t(`tasks.${task.status}`)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Composer({
  firstMessage,
  sending,
  busy,
  stopping,
  element,
  onClearElement,
  onSend,
  onStop,
}: {
  firstMessage: boolean;
  sending: boolean;
  busy: boolean;
  stopping: boolean;
  element: SelectedElement | null;
  onClearElement: () => void;
  /** Resolves true once sent, when what was typed can go. */
  onSend: (text: string, images: string[]) => Promise<boolean>;
  onStop: () => void;
}) {
  const { t } = useTranslation(["studio", "common"]);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  // Pointing at an element is the start of a request about it.
  useEffect(() => {
    if (element !== null) {
      area.current?.focus();
    }
  }, [element]);

  // The field grows with what is typed, then scrolls. Empty, it keeps its two rows: a browser counts
  // the placeholder in the height it reports, and the placeholder of a narrow field is tall.
  const fit = useCallback(() => {
    const field = area.current;
    if (field === null) {
      return;
    }
    if (field.value === "") {
      field.style.height = "";
      return;
    }
    field.style.height = "auto";
    if (field.scrollHeight > 0) {
      field.style.height = `${Math.min(field.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again on each change of text
  useLayoutEffect(fit, [text, fit]);

  // A field that gets wider or narrower wraps its text again.
  useEffect(() => {
    const field = area.current;
    if (field === null || typeof ResizeObserver === "undefined") {
      return;
    }
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth !== width) {
        width = field.clientWidth;
        fit();
      }
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [fit]);

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

  const submit = async () => {
    if (text.trim() === "" && images.length === 0) {
      return;
    }
    if (await onSend(text, images)) {
      setText("");
      setImages([]);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
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
      className="px-3 pt-2.5 pb-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid grid-cols-1 gap-2 rounded-md border bg-raised p-2 transition-colors focus-within:border-accent">
        {element !== null && (
          <div className="min-w-0">
            <ElementChip label={elementLabel(element)} onRemove={onClearElement} />
          </div>
        )}
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
        <textarea
          ref={area}
          aria-label={t("composer.label")}
          placeholder={
            element !== null
              ? t("composer.elementPlaceholder")
              : firstMessage
                ? t("composer.firstPlaceholder")
                : t("composer.placeholder")
          }
          value={text}
          rows={2}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          style={{ maxHeight: COMPOSER_MAX_HEIGHT }}
          className="block w-full resize-none bg-transparent px-1 text-sm leading-relaxed text-ink outline-none placeholder:text-muted"
        />
        <div className="flex items-center gap-1.5">
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
            size="icon-sm"
            variant="ghost"
            aria-label={t("composer.attach")}
            tooltip={t("composer.attach")}
            icon={<ImagePlus aria-hidden="true" className="size-4" />}
            onClick={() => fileInput.current?.click()}
          />
          <span className="flex-1" />
          {busy && (
            <Button
              size="sm"
              variant="secondary"
              pending={stopping}
              icon={<Square aria-hidden="true" className="size-3.5" />}
              onClick={onStop}
            >
              {t("conversation.stop")}
            </Button>
          )}
          <Button
            type="submit"
            size="icon-sm"
            variant="primary"
            pending={sending}
            disabled={text.trim() === "" && images.length === 0}
            aria-label={t("composer.send")}
            tooltip={t("composer.send")}
            icon={<ArrowUp aria-hidden="true" className="size-4" />}
          />
        </div>
      </div>
    </form>
  );
}
