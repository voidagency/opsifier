import type { CompanionState, CompanionTool } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { copyText } from "../../../../lib/clipboard";
import { errorMessage } from "../../../../lib/forms";
import { Button, ConfirmDialog, ErrorState, Lamp, MonoValue, Skeleton, Tooltip, toast } from "../../../../ui";
import { companionsQuery, databasesApi } from "../../../databases/api";
import { useDatabaseParams } from "../../../databases/DatabaseLayout";
import { useActionFollower } from "../../ActionFollower";
import { serviceKey } from "../../api";

function TokenRow({ project, service, tool }: { project: string; service: string; tool: CompanionTool }) {
  const { t } = useTranslation(["service-companions", "common"]);
  const [token, setToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = async (): Promise<string | null> => {
    setPending(true);
    try {
      return (await databasesApi.revealCompanionToken(project, service, tool)).token;
    } catch (error) {
      toast.error(t("revealFailed"), errorMessage(error, t));
      return null;
    } finally {
      setPending(false);
    }
  };

  const copy = async () => {
    const value = token ?? (await load());
    if (value !== null && !(await copyText(value))) {
      toast.error(t("common:copy.failed"));
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="eyebrow mr-2">{t("token")}</span>
      <span className="min-w-0 truncate font-mono text-sm">{token ?? "••••••••"}</span>
      <Tooltip content={token === null ? t("reveal") : t("hide")}>
        <button
          type="button"
          disabled={pending}
          aria-label={token === null ? t("reveal") : t("hide")}
          onClick={async () => setToken(token === null ? await load() : null)}
          className="inline-flex size-6 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
        >
          {token === null ? (
            <Eye aria-hidden="true" className="size-3.5" />
          ) : (
            <EyeOff aria-hidden="true" className="size-3.5" />
          )}
        </button>
      </Tooltip>
      <Tooltip content={t("copyToken")}>
        <button
          type="button"
          aria-label={t("copyToken")}
          onClick={() => void copy()}
          className="inline-flex size-6 items-center justify-center rounded-sm text-muted hover:bg-wash hover:text-ink"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="size-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
      </Tooltip>
    </div>
  );
}

function CompanionCard({ companion, busy }: { companion: CompanionState; busy: boolean }) {
  const { t } = useTranslation(["service-companions", "common"]);
  const { project, service } = useDatabaseParams();
  const queryClient = useQueryClient();
  const follow = useActionFollower();
  const [pending, setPending] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const { tool, enabled, url } = companion;

  const refresh = () => queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });

  const run = async (start: () => Promise<{ id: string }>, success: string, failure: string) => {
    setPending(true);
    try {
      const action = await start();
      follow(action.id, {
        success: () => toast.success(success),
        failure: (ended) => toast.error(failure, ended.error ?? undefined),
      });
      await refresh();
    } catch (error) {
      toast.error(failure, errorMessage(error, t));
    } finally {
      setPending(false);
    }
  };

  const enable = () =>
    run(
      () => databasesApi.enableCompanion(project, service, tool),
      t("enabled", { tool: t(`tools.${tool}.name`) }),
      t("enableFailed"),
    );

  const disable = () =>
    run(
      () => databasesApi.disableCompanion(project, service, tool),
      t("disabled", { tool: t(`tools.${tool}.name`) }),
      t("disableFailed"),
    );

  return (
    <li className="grid gap-3 border-b py-4 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="grid min-w-0 gap-1.5">
        <div className="flex items-center gap-2">
          <Lamp state={enabled ? "running" : "stopped"} label={t(enabled ? "state.on" : "state.off")} />
          <h3 className="text-sm font-medium">{t(`tools.${tool}.name`)}</h3>
        </div>
        <p className="max-w-[60ch] text-sm text-muted">{t(`tools.${tool}.description`)}</p>
        {enabled && url !== null && (
          <div className="grid gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="eyebrow">{t("address")}</span>
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex min-w-0 items-center gap-1 font-mono text-sm hover:underline hover:underline-offset-4"
              >
                <span className="truncate">{url}</span>
                <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
              </a>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <span className="eyebrow">{t("username")}</span>
              <MonoValue value={companion.username ?? ""} />
            </div>
            <TokenRow project={project} service={service} tool={tool} />
          </div>
        )}
        {!enabled && tool === "redis-commander" && <p className="text-xs text-muted">{t("slowStart")}</p>}
      </div>
      {enabled ? (
        <Button variant="secondary" size="sm" disabled={busy || pending} onClick={() => setDisabling(true)}>
          {t("disable")}
        </Button>
      ) : (
        <Button variant="secondary" size="sm" disabled={busy} pending={pending} onClick={enable}>
          {t("enable")}
        </Button>
      )}
      <ConfirmDialog
        open={disabling}
        onOpenChange={setDisabling}
        title={t("confirmDisable.title", { tool: t(`tools.${tool}.name`) })}
        description={t("confirmDisable.description")}
        confirmLabel={t("confirmDisable.submit")}
        onConfirm={disable}
      />
    </li>
  );
}

/** One row per web tool this engine offers, each with its own switch. */
export function CompanionCards({ busy }: { busy: boolean }) {
  const { t } = useTranslation(["service-companions", "common"]);
  const { project, service } = useDatabaseParams();
  const { data, error, refetch, isPending } = useQuery(companionsQuery(project, service));

  return (
    <section className="grid gap-3">
      <h2 className="eyebrow">{t("heading")}</h2>
      {isPending ? (
        <Skeleton className="h-16 max-w-[900px]" />
      ) : data === undefined ? (
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      ) : (
        <ul className="max-w-[900px] border-t">
          {data.companions.map((companion) => (
            <CompanionCard key={companion.tool} companion={companion} busy={busy} />
          ))}
        </ul>
      )}
    </section>
  );
}
