import {
  isStudioConversationId,
  type StudioAppDetail,
  type StudioEvent,
  type StudioModel,
  type StudioRemark,
} from "@opsifier/contract";
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
  MessageSquareText,
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
import { ApiError } from "../../lib/api";
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
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  toast,
} from "../../ui";
import { useCurrentUser } from "../auth/session";
import {
  studioApi,
  studioAppName,
  studioAppQuery,
  studioKey,
  studioModelsQuery,
  studioRemarksQuery,
} from "./api";
import { type ChatItem, changedFiles, type StudioActionEvent, toChatItems, userMessageCount } from "./chat";
import { GuestLinksDialog } from "./GuestLinksDialog";
import { imageToDataUrl } from "./images";
import { PreviewPane, type RemarkFocus } from "./PreviewPane";
import { RemarksPanel } from "./RemarksPanel";
import { ShareDialog } from "./ShareDialog";
import {
  deviceOfWidth,
  elementBlock,
  elementLabel,
  type RemarkTag,
  remarkBlock,
  type SelectedElement,
  splitMessage,
} from "./selection";
import { useConversation } from "./useConversation";

const MAX_IMAGES = 4;
/** How often the preview's state is read while it starts, and otherwise. */
const STARTING_REFRESH_MS = 2000;
/** The longest a start is waited for, a first build included. */
const START_DEADLINE_MS = 10 * 60 * 1000;
const IDLE_REFRESH_MS = 15_000;
const STARTERS = ["design", "mobile", "texts"] as const;
/** The message field grows with what is typed, up to this height, then scrolls. */
const COMPOSER_MAX_HEIGHT = 192;
/** Closer than this to the end, the conversation follows what arrives. */
const FOLLOW_DISTANCE = 48;

type WorkspaceTab = "conversation" | "remarks";

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
  // The left pane holds the conversation, or the remarks left on the preview.
  const [tab, setTab] = useState<WorkspaceTab>("conversation");
  // The remark the next message hands to the agent.
  const [handed, setHanded] = useState<StudioRemark | null>(null);
  const [pinsOn, setPinsOn] = useState(false);
  const [selectedRemark, setSelectedRemark] = useState<string | null>(null);
  const [focus, setFocus] = useState<RemarkFocus | null>(null);
  // The links that open the preview to clients, from the remarks or from the preview's toolbar.
  const [linking, setLinking] = useState(false);
  const remarks = useQuery({
    ...studioRemarksQuery(project, service),
    enabled: user !== null && user !== undefined,
  });
  const showTab = useCallback((next: WorkspaceTab) => {
    setTab(next);
    // Opening the remarks pins them on the preview.
    if (next === "remarks") {
      setPinsOn(true);
    }
  }, []);
  const onRemarkClicked = useCallback(
    (id: string) => {
      showTab("remarks");
      setSelectedRemark(id);
      setPane("chat");
    },
    [showTab],
  );
  const onSelected = useCallback((selection: SelectedElement) => {
    setElement(selection);
    setTab("conversation");
    // On a phone, the element pointed at is the start of a message: back to the conversation.
    setPane("chat");
  }, []);
  const { data, isPending, isError, error, refetch } = useQuery({
    ...studioAppQuery(project, service),
    enabled: user !== null && user !== undefined,
    refetchInterval: (query) =>
      startRequested || query.state.data?.previewStatus === "starting"
        ? STARTING_REFRESH_MS
        : IDLE_REFRESH_MS,
  });

  // A start ends once the preview runs, or once its start or first build is over without it running.
  const sawStarting = useRef(false);
  useEffect(() => {
    const status = data?.previewStatus;
    if (!startRequested) {
      sawStarting.current = false;
    } else if (status === "running") {
      setStartRequested(false);
    } else if (status === "starting") {
      sawStarting.current = true;
    } else if (
      status === "failing" ||
      (sawStarting.current && (status === "undeployed" || status === "stopped"))
    ) {
      setStartRequested(false);
    }
  }, [startRequested, data?.previewStatus]);
  // And never waits forever: a first build takes minutes, not more.
  useEffect(() => {
    if (!startRequested) {
      return;
    }
    const deadline = setTimeout(() => setStartRequested(false), START_DEADLINE_MS);
    return () => clearTimeout(deadline);
  }, [startRequested]);

  if (isPending) {
    return <Skeleton className="m-6 h-[60vh]" />;
  }
  if (isError) {
    return <ErrorState className="m-6" message={errorMessage(error, t)} onRetry={() => refetch()} />;
  }

  // The address bar is anyone's to write: a value that cannot be a conversation's id is ignored.
  const named = isStudioConversationId(search.c) ? search.c : undefined;
  const selected = search.c === "new" ? null : (named ?? data.conversations[0]?.id ?? null);
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
        tab={tab}
        onTab={showTab}
        remarks={remarks.data?.remarks ?? []}
        remarksLoading={remarks.isPending}
        remarksError={remarks.error}
        onRetryRemarks={() => void remarks.refetch()}
        selectedRemark={selectedRemark}
        onShowRemark={(remark) => {
          setSelectedRemark(remark.id);
          setPinsOn(true);
          setFocus((current) => ({ id: remark.id, nonce: (current?.nonce ?? 0) + 1 }));
          // On a phone, the remark is shown on the preview, in place of the list.
          setPane("preview");
        }}
        handed={handed}
        onHandToAgent={(remark) => {
          setHanded(remark);
          setTab("conversation");
          setPane("chat");
        }}
        onClearHanded={() => setHanded(null)}
        onOpenLinks={() => setLinking(true)}
      />
      <PreviewPane
        // Hidden rather than taken away on a phone, so that the preview keeps its page.
        className={pane === "preview" ? undefined : "hidden lg:flex"}
        app={data}
        startRequested={startRequested}
        onStartRequested={() => setStartRequested(true)}
        onStartFailed={() => setStartRequested(false)}
        onSelected={onSelected}
        remarks={(remarks.data?.remarks ?? []).filter(
          (remark) => remark.status !== "done" || remark.id === selectedRemark,
        )}
        pinsOn={pinsOn}
        onTogglePins={() => setPinsOn((on) => !on)}
        focus={focus}
        onRemarkClicked={onRemarkClicked}
        onShare={() => setLinking(true)}
      />
      {linking && (
        <GuestLinksDialog
          project={data.project}
          service={data.service}
          name={studioAppName(data)}
          onClose={() => setLinking(false)}
        />
      )}
    </div>
  );
}

/** How long a project's own agent server may take to start before a message gives up on it. */
const AGENT_START_WAIT_MS = 180_000;
const AGENT_START_RETRY_MS = 4_000;

/** Thrown when the page that sent a message is gone before the agent server was ready. */
class LeftPage extends Error {}

/**
 * Runs `request`, waiting while the project's own agent server starts: it answers that it is starting
 * until it can take the request. Gives up once `alive` says the page is gone.
 */
async function whenAgentReady<T>(
  request: () => Promise<T>,
  onWaiting: (waiting: boolean) => void,
  alive: () => boolean,
): Promise<T> {
  const until = Date.now() + AGENT_START_WAIT_MS;
  for (;;) {
    try {
      const result = await request();
      onWaiting(false);
      return result;
    } catch (reason) {
      if (!(reason instanceof ApiError) || reason.code !== "studio_agent_starting" || Date.now() > until) {
        onWaiting(false);
        throw reason;
      }
      onWaiting(true);
      await new Promise((resolve) => setTimeout(resolve, AGENT_START_RETRY_MS));
      if (!alive()) {
        throw new LeftPage();
      }
    }
  }
}

function ConversationPane({
  app,
  conversationId,
  onSelect,
  element,
  onClearElement,
  tab,
  onTab,
  remarks,
  remarksLoading,
  remarksError,
  onRetryRemarks,
  selectedRemark,
  onShowRemark,
  handed,
  onHandToAgent,
  onClearHanded,
  onOpenLinks,
  className,
}: {
  app: StudioAppDetail;
  conversationId: string | null;
  onSelect: (id: string) => void;
  element: SelectedElement | null;
  onClearElement: () => void;
  tab: WorkspaceTab;
  onTab: (tab: WorkspaceTab) => void;
  remarks: readonly StudioRemark[];
  remarksLoading: boolean;
  remarksError: unknown;
  onRetryRemarks: () => void;
  selectedRemark: string | null;
  onShowRemark: (remark: StudioRemark) => void;
  /** The remark the next message hands to the agent. */
  handed: StudioRemark | null;
  onHandToAgent: (remark: StudioRemark) => void;
  onClearHanded: () => void;
  onOpenLinks: () => void;
  className?: string;
}) {
  const { t } = useTranslation(["studio", "common"]);
  const queryClient = useQueryClient();
  const conversation = useConversation(app.project, app.service, conversationId);
  const busy = conversation.status === "running" || conversation.status === "waiting";
  const [stopping, setStopping] = useState(false);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [agentStarting, setAgentStarting] = useState(false);
  // Whether this pane is still shown: a message waiting for the agent server stops once it is not.
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const admin = useCurrentUser()?.role === "admin";
  const name = studioAppName(app);
  // A conversation that ran on the shared agent server, in a project that has its own now: read only.
  const readOnly = app.conversations.find((one) => one.id === conversationId)?.readOnly === true;
  const [sharing, setSharing] = useState(false);
  const newRemarks = remarks.filter((remark) => remark.status === "new").length;
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

  /** The remark handed to the agent is with it now, in this conversation: its writer sees it is in progress. */
  const markHanded = async (remark: StudioRemark, conversation: string) => {
    try {
      await studioApi.updateRemark(app.project, app.service, remark.id, {
        status: "in_progress",
        conversationId: conversation,
      });
      await queryClient.invalidateQueries({ queryKey: [...studioKey, "remarks", app.project, app.service] });
    } catch (reason) {
      toast.error(errorMessage(reason, t));
    }
  };

  /**
   * Sends what was typed, with the remark handed to the agent and the element pointed at in the preview,
   * to a new conversation or this one.
   */
  const send = async (text: string, images: string[]): Promise<boolean> => {
    if (sending) {
      return false;
    }
    const remark = handed;
    const full = [
      text.trim(),
      remark === null ? null : remarkBlock(remark),
      element === null ? null : elementBlock(element),
    ]
      .filter((part) => part !== null && part !== "")
      .join("\n\n");
    setSending(true);
    setPending({
      conversationId,
      text: full,
      images,
      sentBefore: conversationId === null ? 0 : userMessageCount(conversation.events),
    });
    try {
      if (conversationId === null) {
        const started = await whenAgentReady(
          () =>
            studioApi.start(app.project, app.service, {
              text: full,
              images,
              ...(chosenModel === null ? {} : { model: chosenModel }),
            }),
          setAgentStarting,
          () => alive.current,
        );
        await queryClient.invalidateQueries({ queryKey: [...studioKey, "apps", app.project, app.service] });
        // The message follows into the conversation it started, unless the page was left meanwhile.
        if (!alive.current) {
          return false;
        }
        setPending((current) => (current === null ? null : { ...current, conversationId: started.id }));
        onSelect(started.id);
        if (remark !== null) {
          await markHanded(remark, started.id);
        }
      } else {
        await whenAgentReady(
          () => studioApi.send(app.project, app.service, conversationId, { text: full, images }),
          setAgentStarting,
          () => alive.current,
        );
        conversation.refresh();
        if (remark !== null) {
          await markHanded(remark, conversationId);
        }
      }
      onClearElement();
      onClearHanded();
      return true;
    } catch (reason) {
      if (reason instanceof LeftPage) {
        return false;
      }
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
        <h1 className="min-w-0 flex-1 truncate font-medium">{name}</h1>
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

      <Tabs value={tab} onValueChange={(value) => onTab(value as WorkspaceTab)}>
        <TabsList className="gap-4 px-3">
          <TabsTrigger value="conversation">{t("tabs.conversation")}</TabsTrigger>
          <TabsTrigger value="remarks" className="inline-flex items-center gap-1.5">
            {t("tabs.remarks")}
            {newRemarks > 0 && (
              <span className="min-w-4 rounded-full bg-[#f97316] px-1 text-center font-semibold text-[10px] text-white leading-4">
                <span className="sr-only">{t("tabs.newRemarks", { count: newRemarks })}</span>
                <span aria-hidden="true">{newRemarks}</span>
              </span>
            )}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {sharing && (
        <ShareDialog project={app.project} service={app.service} onClose={() => setSharing(false)} />
      )}

      {tab === "remarks" && (
        <RemarksPanel
          app={app}
          remarks={remarks}
          loading={remarksLoading}
          error={remarksError}
          onRetry={onRetryRemarks}
          selectedId={selectedRemark}
          onSelect={onShowRemark}
          onHandToAgent={onHandToAgent}
          onOpenLinks={onOpenLinks}
        />
      )}
      {/* Hidden rather than taken away, so that what is being typed waits for the person to come back. */}
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", tab === "remarks" && "hidden")}>
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

        {conversation.error !== null &&
          (conversation.error instanceof ApiError && conversation.error.code === "studio_agent_asleep" ? (
            <p role="status" className="border-t px-3 py-2 text-xs text-muted">
              {t("conversation.agentAsleep")}
            </p>
          ) : (
            <p role="alert" className="border-t px-3 py-2 text-xs text-bad wrap-anywhere">
              {errorMessage(conversation.error, t)}
            </p>
          ))}

        {agentStarting && (
          <p role="status" className="border-t px-3 py-2 text-xs text-muted">
            {t("conversation.agentStarting")}
          </p>
        )}

        {!readOnly && suggestions.length > 0 && (
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

        {readOnly ? (
          <div className="grid gap-2 border-t px-3 py-3 text-sm">
            <p className="text-muted">{t("conversation.readOnly")}</p>
            <Link
              to="/studio/$project/$service"
              params={{ project: app.project, service: app.service }}
              search={{ c: "new" }}
              className={cn(buttonClass("primary", "sm"), "justify-self-start")}
            >
              {t("conversation.readOnlyAction")}
            </Link>
          </div>
        ) : (
          <Composer
            firstMessage={conversationId === null}
            sending={sending}
            busy={busy}
            stopping={stopping}
            element={element}
            onClearElement={onClearElement}
            handed={handed}
            onClearHanded={onClearHanded}
            onSend={send}
            onStop={stop}
          />
        )}
      </div>
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
              <p className="font-medium text-ink">
                {t("conversation.emptyTitle", { name: studioAppName(app) })}
              </p>
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

/** A remark handed to the agent: its number, its page, and the screen it was written on. */
function RemarkChip({ tag, onRemove }: { tag: RemarkTag; onRemove?: () => void }) {
  const { t } = useTranslation("studio");
  const label = [
    t("remarks.chip", { number: tag.number }),
    tag.path,
    tag.device === null ? null : t(`preview.devices.${tag.device}`),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 justify-self-start rounded-sm border border-[#f97316]/40 bg-raised px-2 py-0.5 text-xs">
      <MessageSquareText aria-hidden="true" className="size-3.5 shrink-0 text-[#f97316]" />
      <span className="min-w-0 truncate">{label}</span>
      {onRemove !== undefined && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("remarks.unhand")}
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
      {parts.remarks.map((tag) => (
        <span key={`remark-${tag.number}`} className="grid min-w-0 gap-1">
          <RemarkChip tag={tag} />
          {tag.text !== "" && (
            <span className="border-l-2 border-[#f97316]/50 pl-2 text-xs text-muted whitespace-pre-wrap wrap-anywhere">
              {tag.text}
            </span>
          )}
        </span>
      ))}
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
  handed,
  onClearHanded,
  onSend,
  onStop,
}: {
  firstMessage: boolean;
  sending: boolean;
  busy: boolean;
  stopping: boolean;
  element: SelectedElement | null;
  onClearElement: () => void;
  handed: StudioRemark | null;
  onClearHanded: () => void;
  /** Resolves true once sent, when what was typed can go. */
  onSend: (text: string, images: string[]) => Promise<boolean>;
  onStop: () => void;
}) {
  const { t } = useTranslation(["studio", "common"]);
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  // Pointing at an element, or handing a remark over, is the start of a request about it.
  useEffect(() => {
    if (element !== null || handed !== null) {
      area.current?.focus();
    }
  }, [element, handed]);

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

  // A remark handed over is a message on its own: the person may add to it, or send it as it is.
  const empty = text.trim() === "" && images.length === 0 && handed === null;

  const submit = async () => {
    if (empty) {
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
        {handed !== null && (
          <div className="grid min-w-0 gap-1">
            <RemarkChip
              tag={{
                number: handed.number,
                path: handed.path,
                device: handed.viewport === null ? null : deviceOfWidth(handed.viewport.width),
                text: handed.text,
              }}
              onRemove={onClearHanded}
            />
            {handed.element !== null && <ElementChip label={elementLabel(handed.element)} />}
            <p className="line-clamp-3 border-l-2 border-[#f97316]/50 pl-2 text-xs text-muted wrap-anywhere">
              {handed.text}
            </p>
          </div>
        )}
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
            handed !== null
              ? t("composer.remarkPlaceholder")
              : element !== null
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
            disabled={empty}
            aria-label={t("composer.send")}
            tooltip={t("composer.send")}
            icon={<ArrowUp aria-hidden="true" className="size-4" />}
          />
        </div>
      </div>
    </form>
  );
}
