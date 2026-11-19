import type { StudioAppDetail, StudioRemark } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Check,
  Link2,
  MessageSquareText,
  Monitor,
  RotateCcw,
  Smartphone,
  Tablet,
  Trash2,
} from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { formatRelativeTime } from "../../lib/format";
import { errorMessage } from "../../lib/forms";
import { Button, ConfirmDialog, Dialog, ErrorState, Segmented, Skeleton, Tooltip, toast } from "../../ui";
import { studioApi, studioKey, studioRemarkScreenshotQuery } from "./api";
import { deviceOfWidth, elementLabel } from "./selection";

const DEVICE_ICONS = { desktop: Monitor, tablet: Tablet, mobile: Smartphone } as const;

/** The colour of a remark's pin, here as on the preview: to deal with, with the agent, dealt with. */
export const REMARK_COLORS: Record<StudioRemark["status"], string> = {
  new: "#f97316",
  in_progress: "#2563eb",
  done: "#6b7280",
};

export function RemarkBubble({ remark, className }: { remark: StudioRemark; className?: string }) {
  return (
    <span
      aria-hidden="true"
      style={{ background: REMARK_COLORS[remark.status] }}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-full font-semibold text-[11px] text-white",
        className,
      )}
    >
      {remark.status === "done" ? <Check className="size-3.5" /> : remark.number}
    </span>
  );
}

type Filter = "open" | "done";

/**
 * Whether an element has come near the visible part of its list once: a project keeps hundreds of
 * remarks, whose screenshots are read only as they come into view. Without a way to tell, it has.
 */
function useSeen<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const node = ref.current;
    if (seen || node === null) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen];
}

/**
 * The screenshot a remark came with, small on its card: the window its writer saw, the element outlined
 * and the pin where they clicked. A click shows it at its size.
 */
function RemarkScreenshot({ app, remark }: { app: StudioAppDetail; remark: StudioRemark }) {
  const { t } = useTranslation(["studio", "common"]);
  const [open, setOpen] = useState(false);
  const [place, seen] = useSeen<HTMLDivElement>();
  const image = useQuery({
    ...studioRemarkScreenshotQuery(app.project, app.service, remark.id),
    enabled: seen,
  });
  if (image.isError) {
    return <p className="text-xs text-muted">{t("remarks.screenshotFailed")}</p>;
  }
  if (image.data === undefined) {
    return (
      <div ref={place}>
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  const alt = t("remarks.screenshotAlt", { number: remark.number });
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("remarks.screenshotShow", { number: remark.number })}
        className="block overflow-hidden rounded-sm border bg-wash hover:border-accent"
      >
        <img src={image.data} alt={alt} className="block h-24 w-full object-cover object-top" />
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="lg"
        title={t("remarks.screenshotTitle", { number: remark.number })}
        description={t("remarks.screenshotDescription")}
      >
        <img src={image.data} alt={alt} className="mx-auto block h-auto max-w-full rounded-sm border" />
      </Dialog>
    </>
  );
}

/**
 * What clients and reviewers wrote on the project's preview: the ones to deal with, and those dealt
 * with. Each can be handed to the agent, which gets it in the next message with its element, and
 * marked dealt with, which its writer sees on the preview.
 */
export function RemarksPanel({
  app,
  remarks,
  loading,
  error,
  onRetry,
  selectedId,
  onSelect,
  onHandToAgent,
  onOpenLinks,
}: {
  app: StudioAppDetail;
  remarks: readonly StudioRemark[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  selectedId: string | null;
  /** The remark to show on the preview. */
  onSelect: (remark: StudioRemark) => void;
  onHandToAgent: (remark: StudioRemark) => void;
  onOpenLinks: () => void;
}) {
  const { t, i18n } = useTranslation(["studio", "common"]);
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<StudioRemark | null>(null);
  const open = remarks.filter((remark) => remark.status !== "done");
  const done = remarks.filter((remark) => remark.status === "done");
  const shown = filter === "open" ? open : done;

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: [...studioKey, "remarks", app.project, app.service] });

  const setStatus = async (remark: StudioRemark, status: StudioRemark["status"]) => {
    setBusy(remark.id);
    try {
      await studioApi.updateRemark(app.project, app.service, remark.id, { status });
      await refresh();
      if (status === "done") {
        toast.success(t("remarks.doneToast", { number: remark.number }));
      }
    } catch (reason) {
      toast.error(errorMessage(reason, t));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (remark: StudioRemark) => {
    await studioApi.deleteRemark(app.project, app.service, remark.id);
    await refresh();
    toast.success(t("remarks.deleted", { number: remark.number }));
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Segmented
          label={t("remarks.filter")}
          value={filter}
          onChange={setFilter}
          options={[
            { value: "open", label: t("remarks.open", { count: open.length }) },
            { value: "done", label: t("remarks.done", { count: done.length }) },
          ]}
        />
        <span className="flex-1" />
        <Button
          size="sm"
          variant="secondary"
          icon={<Link2 aria-hidden="true" className="size-3.5" />}
          onClick={onOpenLinks}
        >
          {t("links.action")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {error !== null && error !== undefined ? (
          <ErrorState message={errorMessage(error, t)} onRetry={onRetry} />
        ) : loading ? (
          <Skeleton className="h-24" />
        ) : remarks.length === 0 ? (
          <div className="grid justify-items-start gap-2 py-6 text-sm">
            <MessageSquareText aria-hidden="true" className="size-6 text-accent" />
            <p className="font-medium text-ink">{t("remarks.emptyTitle")}</p>
            <p className="text-muted">{t("remarks.emptyDescription")}</p>
            <Button
              size="sm"
              variant="primary"
              icon={<Link2 aria-hidden="true" className="size-3.5" />}
              onClick={onOpenLinks}
            >
              {t("links.create")}
            </Button>
          </div>
        ) : shown.length === 0 ? (
          <p className="py-6 text-sm text-muted">
            {filter === "open" ? t("remarks.noneOpen") : t("remarks.noneDone")}
          </p>
        ) : (
          <ol className="grid grid-cols-1 gap-2.5" aria-label={t("remarks.label")}>
            {shown.map((remark) => {
              const device = remark.viewport === null ? null : deviceOfWidth(remark.viewport.width);
              const DeviceIcon = device === null ? null : DEVICE_ICONS[device];
              const selected = remark.id === selectedId;
              return (
                <li
                  key={remark.id}
                  className={cn(
                    "grid min-w-0 grid-cols-1 gap-2 rounded-md border bg-raised p-2.5 transition-colors",
                    selected && "border-accent",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(remark)}
                    aria-label={t("remarks.show", { number: remark.number })}
                    className="-m-1 grid min-w-0 grid-cols-1 gap-1.5 rounded-sm p-1 text-left hover:bg-wash"
                  >
                    <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
                      <RemarkBubble remark={remark} />
                      <span className="min-w-0 truncate font-mono text-ink">{remark.path}</span>
                      {DeviceIcon !== null && device !== null && (
                        <span className="inline-flex shrink-0 items-center gap-1">
                          <DeviceIcon aria-hidden="true" className="size-3.5" />
                          {t(`preview.devices.${device}`)}
                        </span>
                      )}
                      <span className="ml-auto shrink-0">
                        {formatRelativeTime(remark.createdAt, i18n.language)}
                      </span>
                    </span>
                    {remark.element !== null && (
                      <span className="min-w-0 truncate font-mono text-xs text-muted">
                        {elementLabel(remark.element)}
                      </span>
                    )}
                    <span className="whitespace-pre-wrap text-sm text-ink wrap-anywhere">{remark.text}</span>
                    <span className="text-xs text-muted">
                      {remark.authorKind === "guest"
                        ? t("remarks.fromClient", { name: remark.author })
                        : remark.author}
                      {remark.status === "in_progress" && ` · ${t("remarks.withAgent")}`}
                    </span>
                  </button>
                  {remark.screenshot && <RemarkScreenshot app={app} remark={remark} />}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {remark.status !== "done" && (
                      <Button
                        size="sm"
                        variant={remark.status === "new" ? "primary" : "secondary"}
                        icon={<Bot aria-hidden="true" className="size-3.5" />}
                        onClick={() => onHandToAgent(remark)}
                      >
                        {remark.status === "new" ? t("remarks.handToAgent") : t("remarks.handAgain")}
                      </Button>
                    )}
                    {remark.status === "done" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        pending={busy === remark.id}
                        icon={<RotateCcw aria-hidden="true" className="size-3.5" />}
                        onClick={() => void setStatus(remark, "new")}
                      >
                        {t("remarks.reopen")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        pending={busy === remark.id}
                        icon={<Check aria-hidden="true" className="size-3.5" />}
                        onClick={() => void setStatus(remark, "done")}
                      >
                        {t("remarks.markDone")}
                      </Button>
                    )}
                    <span className="flex-1" />
                    <Tooltip content={t("remarks.delete", { number: remark.number })}>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("remarks.delete", { number: remark.number })}
                        icon={<Trash2 aria-hidden="true" className="size-3.5" />}
                        onClick={() => setDeleting(remark)}
                      />
                    </Tooltip>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {deleting !== null && (
        <ConfirmDialog
          open
          onOpenChange={(next) => !next && setDeleting(null)}
          title={t("remarks.deleteTitle", { number: deleting.number })}
          description={t("remarks.deleteDescription")}
          confirmLabel={t("remarks.deleteConfirm")}
          tone="danger"
          onConfirm={async () => {
            await remove(deleting);
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
}
