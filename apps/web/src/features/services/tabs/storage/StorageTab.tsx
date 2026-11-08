import type { MountEntry } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, FolderInput, HardDrive, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../../../lib/forms";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  FormBanner,
  MonoValue,
  Skeleton,
  Tooltip,
  toast,
} from "../../../../ui";
import { useServiceParams } from "../../api";
import { storageApi, storageQuery } from "./api";
import { MountDialog, type MountKind } from "./MountDialog";

type Pending =
  | { kind: "create"; mountKind: MountKind }
  | { kind: "edit"; index: number; mount: MountEntry }
  | { kind: "delete"; index: number; mount: MountEntry };

export function StorageTab() {
  const { t } = useTranslation(["service-storage", "common"]);
  const { project, service } = useServiceParams();
  const queryClient = useQueryClient();
  const query = storageQuery(project, service);
  const { data, isPending, isError, error, refetch } = useQuery(query);
  const [pending, setPending] = useState<Pending | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: query.queryKey });
  const close = () => setPending(null);

  const adds = (
    <div className="flex flex-wrap gap-2">
      <Button
        icon={<FolderInput aria-hidden="true" className="size-4" />}
        onClick={() => setPending({ kind: "create", mountKind: "bind" })}
      >
        {t("add.bind")}
      </Button>
      <Button
        icon={<HardDrive aria-hidden="true" className="size-4" />}
        onClick={() => setPending({ kind: "create", mountKind: "volume" })}
      >
        {t("add.volume")}
      </Button>
      <Button
        icon={<FileText aria-hidden="true" className="size-4" />}
        onClick={() => setPending({ kind: "create", mountKind: "file" })}
      >
        {t("add.file")}
      </Button>
    </div>
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
    if (data.mounts.length === 0) {
      return <EmptyState title={t("empty.title")} description={t("empty.description")} action={adds} />;
    }
    return (
      <div className="grid gap-4">
        <ul className="border-y">
          {data.mounts.map((mount, index) => (
            <li
              key={`${mount.type}:${mount.mountPath}`}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b py-2.5 last:border-b-0"
            >
              <Badge mono>{t(`kinds.${mount.type}`)}</Badge>
              <span className="grid min-w-0 gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                  <MonoValue
                    value={
                      mount.type === "bind"
                        ? mount.hostPath
                        : mount.type === "volume"
                          ? mount.name
                          : t("kinds.fileLabel")
                    }
                    truncate
                  />
                  <span aria-hidden="true" className="text-muted">
                    →
                  </span>
                  <MonoValue value={mount.mountPath} truncate />
                </span>
                {mount.type === "bind" && mount.risk !== null && (
                  <span className="text-xs text-bad">{t(`riskBadge.${mount.risk}`)}</span>
                )}
              </span>
              <span className="flex items-center gap-1">
                <Tooltip content={t("edit")}>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("edit")}
                    onClick={() => setPending({ kind: "edit", index, mount })}
                  >
                    <Pencil aria-hidden="true" className="size-4" />
                  </Button>
                </Tooltip>
                <Tooltip content={t("delete")}>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("delete")}
                    onClick={() => setPending({ kind: "delete", index, mount })}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </Button>
                </Tooltip>
              </span>
            </li>
          ))}
        </ul>
        {adds}
      </div>
    );
  };

  return (
    <section className="grid gap-x-10 gap-y-4 px-4 py-6 md:px-6 lg:grid-cols-[minmax(0,260px)_minmax(0,720px)] lg:px-8">
      <div>
        <h2 className="text-md font-medium">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted">{t("description")}</p>
      </div>
      {body()}

      {pending?.kind === "create" && (
        <MountDialog
          project={project}
          service={service}
          kind={pending.mountKind}
          onClose={close}
          onSaved={refresh}
        />
      )}
      {pending?.kind === "edit" && (
        <MountDialog
          project={project}
          service={service}
          kind={pending.mount.type}
          editing={pending}
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
            ? t("deleteDialog.description", { path: pending.mount.mountPath })
            : undefined
        }
        confirmLabel={t("deleteDialog.confirm")}
        onConfirm={async () => {
          if (pending?.kind === "delete") {
            await storageApi.remove(project, service, pending.index);
            await refresh();
            toast.success(t("deleted"), t("savedHint"));
          }
        }}
      />
    </section>
  );
}
