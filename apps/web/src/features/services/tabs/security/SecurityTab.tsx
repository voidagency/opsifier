import type { BasicAuthEntry } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Eye, EyeOff, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { copyText } from "../../../../lib/clipboard";
import { errorMessage } from "../../../../lib/forms";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  MonoValue,
  Pictogram,
  SectionIntro,
  Skeleton,
  Tooltip,
  toast,
} from "../../../../ui";
import { serviceKey, useServiceParams } from "../../api";
import { basicAuthApi, basicAuthQuery } from "./api";
import { BasicAuthDialog } from "./BasicAuthDialog";

type Pending =
  | { kind: "create" }
  | { kind: "edit"; entry: BasicAuthEntry }
  | { kind: "delete"; entry: BasicAuthEntry };

const MASK = "••••••••••";
const iconButton =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink disabled:opacity-45";

/**
 * One user's password, masked. Showing it and copying it both go through the audited reveal
 * endpoint. A password from before the panel kept them cannot be shown: the user needs a new one.
 */
function PasswordLine({
  project,
  service,
  entry,
  onSetNew,
}: {
  project: string;
  service: string;
  entry: BasicAuthEntry;
  onSetNew: () => void;
}) {
  const { t } = useTranslation(["service-security", "common"]);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!entry.revealable) {
    return (
      <span className="text-xs text-muted">
        {t("passwordNotKept")}{" "}
        <button type="button" onClick={onSetNew} className="underline underline-offset-2 hover:text-ink">
          {t("setNewPassword")}
        </button>
      </span>
    );
  }

  const fetchPassword = async (): Promise<string | null> => {
    setFetching(true);
    try {
      return (await basicAuthApi.reveal(project, service, entry.id)).value;
    } catch (error) {
      toast.error(t("revealFailed"), errorMessage(error, t));
      return null;
    } finally {
      setFetching(false);
    }
  };

  const toggle = async () => {
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    setRevealed(await fetchPassword());
  };

  const copy = async () => {
    const value = revealed ?? (await fetchPassword());
    if (value === null) {
      return;
    }
    if (await copyText(value)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } else {
      toast.error(t("common:copy.failed"));
    }
  };

  return (
    <span className="flex min-w-0 items-center gap-1">
      {revealed === null ? (
        <span className="font-mono text-xs text-muted">
          <span aria-hidden="true">{MASK}</span>
          <span className="sr-only">{t("passwordMasked")}</span>
        </span>
      ) : (
        <span className="min-w-0 break-all font-mono text-xs">{revealed}</span>
      )}
      <Tooltip content={revealed === null ? t("reveal") : t("hide")}>
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={fetching}
          aria-label={revealed === null ? t("reveal") : t("hide")}
          aria-pressed={revealed !== null}
          className={iconButton}
        >
          {revealed === null ? (
            <Eye aria-hidden="true" className="size-3.5" />
          ) : (
            <EyeOff aria-hidden="true" className="size-3.5" />
          )}
        </button>
      </Tooltip>
      <Tooltip content={copied ? t("common:copy.copied") : t("copyPassword")}>
        <button
          type="button"
          onClick={() => void copy()}
          disabled={fetching}
          aria-label={copied ? t("common:copy.copied") : t("copyPassword")}
          className={iconButton}
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3.5 text-ok" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" />
          )}
        </button>
      </Tooltip>
    </span>
  );
}

export function SecurityTab() {
  const { t } = useTranslation(["service-security", "common"]);
  const { project, service } = useServiceParams();
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(basicAuthQuery(project, service));
  const [pending, setPending] = useState<Pending | null>(null);
  // Bumped on every change, so that no password shown before it stays on screen after it.
  const [generation, setGeneration] = useState(0);

  const refresh = () => {
    setGeneration((value) => value + 1);
    return queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
  };
  const close = () => setPending(null);

  const add = (
    <Button
      variant="primary"
      icon={<Plus aria-hidden="true" className="size-4" />}
      onClick={() => setPending({ kind: "create" })}
    >
      {t("add")}
    </Button>
  );

  const body = () => {
    if (isPending) {
      return <Skeleton className="h-6" />;
    }
    if (isError) {
      return <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />;
    }
    if (data.entries.length === 0) {
      return (
        <EmptyState
          illustration="service-stopped"
          title={t("empty.title")}
          description={t("empty.description")}
          action={add}
        />
      );
    }
    return (
      <div className="grid gap-4">
        <ul className="border-y">
          {data.entries.map((entry) => (
            <li
              key={entry.id}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b py-2.5 last:border-b-0"
            >
              <Pictogram name="user" className="text-muted" />
              <span className="grid min-w-0 gap-0.5">
                <MonoValue
                  value={entry.username}
                  copy
                  copyLabel={t("copyUsername")}
                  truncate
                  className="text-sm"
                />
                <PasswordLine
                  key={`${entry.id}-${generation}`}
                  project={project}
                  service={service}
                  entry={entry}
                  onSetNew={() => setPending({ kind: "edit", entry })}
                />
              </span>
              <span className="flex items-center gap-1">
                <Tooltip content={t("edit")}>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("edit")}
                    onClick={() => setPending({ kind: "edit", entry })}
                  >
                    <Pencil aria-hidden="true" className="size-4" />
                  </Button>
                </Tooltip>
                <Tooltip content={t("delete")}>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("delete")}
                    onClick={() => setPending({ kind: "delete", entry })}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </Button>
                </Tooltip>
              </span>
            </li>
          ))}
        </ul>
        <div>{add}</div>
      </div>
    );
  };

  return (
    <section className="grid gap-x-10 gap-y-4 px-4 py-6 md:px-6 lg:grid-cols-[minmax(0,260px)_minmax(0,620px)] lg:px-8">
      <SectionIntro pictogram="access" title={t("title")} description={t("description")} />
      {body()}

      {(pending?.kind === "create" || pending?.kind === "edit") && (
        <BasicAuthDialog
          project={project}
          service={service}
          entry={pending.kind === "edit" ? pending.entry : undefined}
          onClose={close}
          onSaved={refresh}
        />
      )}

      <ConfirmDialog
        open={pending?.kind === "delete"}
        onOpenChange={(open) => !open && close()}
        title={t("deleteDialog.title")}
        description={
          pending?.kind === "delete"
            ? t("deleteDialog.description", { username: pending.entry.username })
            : undefined
        }
        confirmLabel={t("deleteDialog.confirm")}
        onConfirm={async () => {
          if (pending?.kind === "delete") {
            await basicAuthApi.remove(project, service, pending.entry.id);
            await refresh();
            toast.success(t("deleted"));
          }
        }}
      />
    </section>
  );
}
