import type { BasicAuthEntry } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../../../lib/forms";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  FormBanner,
  MonoValue,
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

export function SecurityTab() {
  const { t } = useTranslation(["service-security", "common"]);
  const { project, service } = useServiceParams();
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(basicAuthQuery(project, service));
  const [pending, setPending] = useState<Pending | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
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
    if (data.entries.length === 0) {
      return <EmptyState title={t("empty.title")} description={t("empty.description")} action={add} />;
    }
    return (
      <div className="grid gap-4">
        <ul className="border-y">
          {data.entries.map((entry) => (
            <li
              key={entry.id}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b py-2.5 last:border-b-0"
            >
              <KeyRound aria-hidden="true" className="size-4 text-muted" />
              <span className="grid min-w-0 gap-0.5">
                <MonoValue
                  value={entry.username}
                  copy
                  copyLabel={t("copyUsername")}
                  truncate
                  className="text-sm"
                />
                <span className="text-xs text-muted">{t("passwordHidden")}</span>
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
      <div>
        <h2 className="text-md font-medium">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted">{t("description")}</p>
      </div>
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
