import { type ActionEntry, actionsTopic } from "@opsifier/contract";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Ban, ScrollText, User } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { formatDuration, formatRelativeTime } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import { useTopic } from "../../lib/realtime";
import {
  Button,
  EmptyState,
  FormBanner,
  PageHeader,
  Skeleton,
  StatusLamp,
  Tooltip,
  toast,
  WakeFigure,
} from "../../ui";
import { ActionLogDialog } from "./ActionLogDialog";
import { actionsApi, activityKey, activityQuery } from "./api";
import { actionLabel, actionTarget, lampForAction } from "./labels";

type ActivityData = NonNullable<ReturnType<typeof useActivityData>>;

function useActivityData() {
  return useInfiniteQuery(activityQuery).data;
}

/** Applies one Action event to the cached pages: an update in place, or a new row on top. */
function applyActionEvent(data: ActivityData | undefined, action: ActionEntry): ActivityData | undefined {
  if (data === undefined) {
    return data;
  }
  let found = false;
  const pages = data.pages.map((page) => ({
    ...page,
    items: page.items.map((item) => {
      if (item.id !== action.id) {
        return item;
      }
      found = true;
      return action;
    }),
  }));
  const [first, ...rest] = pages;
  if (found || first === undefined) {
    return { ...data, pages };
  }
  return { ...data, pages: [{ ...first, items: [action, ...first.items] }, ...rest] };
}

function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function ActionRow({
  action,
  now,
  onView,
}: {
  action: ActionEntry;
  now: number;
  onView: (action: ActionEntry) => void;
}) {
  const { t, i18n } = useTranslation(["activity", "common"]);
  const [cancelling, setCancelling] = useState(false);
  const target = actionTarget(action);
  const active = action.status === "queued" || action.status === "running";

  const cancel = async () => {
    setCancelling(true);
    try {
      await actionsApi.cancel(action.id);
    } catch (error) {
      toast.error(errorMessage(error, t));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b px-1 py-2 last:border-b-0 md:grid-cols-[auto_minmax(0,1fr)_72px_130px_116px] md:gap-x-5">
      <StatusLamp status={lampForAction(action.status)} label={t(`status.${action.status}`)} />
      <span className="min-w-0">
        <span className="block truncate text-sm">{actionLabel(action, t)}</span>
        <span
          className={cn(
            "block truncate font-mono text-xs",
            action.status === "failed" ? "text-bad" : "text-muted",
          )}
        >
          {action.status === "failed" && action.error ? action.error : target}
        </span>
      </span>
      <span className="justify-self-end font-mono text-xs text-muted md:col-start-3 md:justify-self-start">
        {action.startedAt === null ? "--" : formatDuration(action.startedAt, action.finishedAt, now)}
      </span>
      <span className="col-start-2 text-xs text-muted md:col-start-4">
        {formatRelativeTime(action.createdAt, i18n.language, now)}
      </span>
      <span className="col-span-2 flex items-center justify-end gap-0.5 md:col-span-1">
        {action.actorEmail !== null && (
          <Tooltip content={action.actorEmail}>
            <button type="button" className="flex size-7 items-center justify-center rounded-sm text-muted">
              <User aria-hidden="true" className="size-3.5" />
              <span className="sr-only">{t("activity:startedBy", { email: action.actorEmail })}</span>
            </button>
          </Tooltip>
        )}
        {action.serviceName !== null && action.projectName !== null && (
          <Tooltip content={t("activity:openService")}>
            <Link
              to="/projects/$project/app/$service/"
              params={{ project: action.projectName, service: action.serviceName }}
              aria-label={t("activity:openService")}
              className="flex size-7 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
            >
              <span aria-hidden="true" className="text-xs">
                ↗
              </span>
            </Link>
          </Tooltip>
        )}
        {active && (
          <Tooltip content={t("activity:stop")}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("activity:stop")}
              pending={cancelling}
              onClick={cancel}
            >
              <Ban aria-hidden="true" className="size-3.5" />
            </Button>
          </Tooltip>
        )}
        {action.hasLog && (
          <Tooltip content={t("activity:view")}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("activity:view")}
              onClick={() => onView(action)}
            >
              <ScrollText aria-hidden="true" className="size-3.5" />
            </Button>
          </Tooltip>
        )}
      </span>
    </li>
  );
}

export function ActivityPage() {
  const { t } = useTranslation(["activity", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery(activityQuery);
  const [viewing, setViewing] = useState<ActionEntry | null>(null);

  useTopic<ActionEntry>(actionsTopic, (action) => {
    queryClient.setQueryData<ActivityData>(activityKey, (current) => applyActionEvent(current, action));
  });

  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const running = items.some((action) => action.status === "queued" || action.status === "running");
  const now = useTick(running);

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="px-4 py-6 md:px-6 lg:px-8">
        {isPending ? (
          <div className="grid max-w-[960px] gap-3">
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        ) : isError ? (
          <div className="grid max-w-[520px] justify-items-start gap-3">
            <FormBanner>{errorMessage(error, t)}</FormBanner>
            <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
          </div>
        ) : items.length === 0 ? (
          <EmptyState figure={<WakeFigure />} title={t("empty.title")} description={t("empty.description")} />
        ) : (
          <div className="grid max-w-[960px] gap-4">
            <ul className="border-y">
              {items.map((action) => (
                <ActionRow key={action.id} action={action} now={now} onView={setViewing} />
              ))}
            </ul>
            {hasNextPage && (
              <div>
                <Button pending={isFetchingNextPage} onClick={() => fetchNextPage()}>
                  {t("loadMore")}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      <ActionLogDialog action={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
