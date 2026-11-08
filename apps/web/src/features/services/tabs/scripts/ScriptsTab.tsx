import type { ScriptSpec } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../../../lib/forms";
import { Button, ConfirmDialog, EmptyState, FormBanner, Skeleton, Tooltip, toast } from "../../../../ui";
import { useServiceParams } from "../../api";
import { scriptsApi, scriptsQuery } from "./api";
import { ScriptDialog } from "./ScriptDialog";

type Pending =
  | { kind: "create" }
  | { kind: "edit"; index: number; script: ScriptSpec }
  | { kind: "delete"; index: number; script: ScriptSpec };

export function ScriptsTab() {
  const { t } = useTranslation(["service-scripts", "common"]);
  const { project, service } = useServiceParams();
  const queryClient = useQueryClient();
  const query = scriptsQuery(project, service);
  const { data, isPending, isError, error, refetch } = useQuery(query);
  const [pending, setPending] = useState<Pending | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: query.queryKey });
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
      return (
        <div className="grid justify-items-start gap-3">
          <FormBanner>{errorMessage(error, t)}</FormBanner>
          <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
        </div>
      );
    }
    if (data.scripts.length === 0) {
      return <EmptyState title={t("empty.title")} description={t("empty.description")} action={add} />;
    }
    return (
      <div className="grid gap-4">
        <ul className="border-y">
          {data.scripts.map((script, index) => (
            <li
              key={script.name}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b py-2.5 last:border-b-0"
            >
              <span className="grid min-w-0 gap-0.5">
                <span className="truncate text-sm font-medium">{script.name}</span>
                <span className="truncate font-mono text-xs text-muted">
                  {script.script.split("\n", 1)[0] || t("emptyScript")}
                </span>
              </span>
              <span className="flex items-center gap-1">
                <Tooltip content={t("edit")}>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("edit")}
                    onClick={() => setPending({ kind: "edit", index, script })}
                  >
                    <Pencil aria-hidden="true" className="size-4" />
                  </Button>
                </Tooltip>
                <Tooltip content={t("delete")}>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("delete")}
                    onClick={() => setPending({ kind: "delete", index, script })}
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
      <div>
        <h2 className="text-md font-medium">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted">{t("description")}</p>
      </div>
      {body()}

      {(pending?.kind === "create" || pending?.kind === "edit") && (
        <ScriptDialog
          project={project}
          service={service}
          editing={pending.kind === "edit" ? pending : undefined}
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
            ? t("deleteDialog.description", { name: pending.script.name })
            : undefined
        }
        confirmLabel={t("deleteDialog.confirm")}
        onConfirm={async () => {
          if (pending?.kind === "delete") {
            await scriptsApi.remove(project, service, pending.index);
            await refresh();
            toast.success(t("deleted"));
          }
        }}
      />
    </section>
  );
}
