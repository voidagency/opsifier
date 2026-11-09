import type { RedirectRule } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../../../lib/forms";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Lamp,
  MonoValue,
  Pictogram,
  Skeleton,
  Tooltip,
  toast,
} from "../../../../ui";
import { serviceKey, useServiceParams } from "../../api";
import { redirectsApi, redirectsQuery } from "./api";
import { RedirectDialog } from "./RedirectDialog";

type Pending =
  | { kind: "create" }
  | { kind: "edit"; rule: RedirectRule }
  | { kind: "delete"; rule: RedirectRule };

export function RedirectsTab() {
  const { t } = useTranslation(["service-redirects", "common"]);
  const { project, service } = useServiceParams();
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(redirectsQuery(project, service));
  const [pending, setPending] = useState<Pending | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
  const close = () => setPending(null);

  if (isPending) {
    return (
      <div className="grid max-w-[1100px] gap-3 px-4 py-6 md:px-6 lg:px-8">
        <Skeleton className="h-6" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      </div>
    );
  }

  const add = (
    <Button
      variant="primary"
      icon={<Plus aria-hidden="true" className="size-4" />}
      onClick={() => setPending({ kind: "create" })}
    >
      {t("add")}
    </Button>
  );

  return (
    <div className="grid gap-6 px-4 py-6 md:px-6 lg:px-8">
      {data.redirects.length === 0 ? (
        <EmptyState
          illustration="no-domains"
          title={t("empty.title")}
          description={t("empty.description")}
          action={add}
        />
      ) : (
        <div className="grid max-w-[1100px] gap-4">
          <ul className="border-y">
            {data.redirects.map((rule) => (
              <li
                key={rule.id}
                className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b py-2.5 last:border-b-0"
              >
                <Lamp
                  state={rule.enabled ? "running" : "stopped"}
                  label={rule.enabled ? t("enabled") : t("disabled")}
                />
                <Pictogram name="redirect" className="text-muted" />
                <span className={rule.enabled ? "grid min-w-0 gap-0.5" : "grid min-w-0 gap-0.5 opacity-60"}>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <MonoValue value={rule.regex} truncate className="text-sm" />
                    <Badge tone={rule.permanent ? "accent" : "neutral"}>
                      {rule.permanent ? t("permanent") : t("temporary")}
                    </Badge>
                    {!rule.enabled && <Badge tone="off">{t("disabled")}</Badge>}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                    <span aria-hidden="true">→</span>
                    <MonoValue value={rule.replacement} truncate />
                  </span>
                </span>
                <span className="flex items-center gap-1">
                  <Tooltip content={t("edit")}>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("edit")}
                      onClick={() => setPending({ kind: "edit", rule })}
                    >
                      <Pencil aria-hidden="true" className="size-4" />
                    </Button>
                  </Tooltip>
                  <Tooltip content={t("delete")}>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("delete")}
                      onClick={() => setPending({ kind: "delete", rule })}
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
      )}

      {(pending?.kind === "create" || pending?.kind === "edit") && (
        <RedirectDialog
          project={project}
          service={service}
          rule={pending.kind === "edit" ? pending.rule : undefined}
          onClose={close}
          onSaved={refresh}
        />
      )}

      <ConfirmDialog
        open={pending?.kind === "delete"}
        onOpenChange={(open) => !open && close()}
        title={t("deleteDialog.title")}
        description={t("deleteDialog.description")}
        confirmLabel={t("deleteDialog.confirm")}
        onConfirm={async () => {
          if (pending?.kind === "delete") {
            await redirectsApi.remove(project, service, pending.rule.id);
            await refresh();
            toast.success(t("deleted"));
          }
        }}
      />
    </div>
  );
}
