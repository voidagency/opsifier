import type { PortSpec } from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  MonoValue,
  Pictogram,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Tooltip,
  TR,
  toast,
} from "../../../../ui";
import { advancedApi, advancedQuery } from "./api";
import { PortDialog } from "./PortDialog";

type Pending =
  | { kind: "create" }
  | { kind: "edit"; index: number; port: PortSpec }
  | { kind: "delete"; index: number; port: PortSpec }
  | { kind: "deleteAll" };

export function PortsSection({
  project,
  service,
  ports,
}: {
  project: string;
  service: string;
  ports: readonly PortSpec[];
}) {
  const { t } = useTranslation(["service-advanced", "common"]);
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: advancedQuery(project, service).queryKey });
  const close = () => setPending(null);

  const add = (
    <Button
      icon={<Plus aria-hidden="true" className="size-4" />}
      onClick={() => setPending({ kind: "create" })}
    >
      {t("ports.add")}
    </Button>
  );

  return (
    <div className="grid gap-4">
      {ports.length === 0 ? (
        <EmptyState
          illustration="no-services"
          title={t("ports.empty.title")}
          description={t("ports.empty.description")}
          action={add}
        />
      ) : (
        <>
          <Table>
            <THead>
              <TR>
                <TH>{t("ports.protocol")}</TH>
                <TH numeric>{t("ports.published")}</TH>
                <TH numeric>{t("ports.target")}</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {ports.map((port, index) => (
                <TR key={`${port.protocol}:${port.published}`}>
                  <TD mono>
                    <span className="inline-flex items-center gap-2">
                      <Pictogram name="port" size={16} className="text-muted" />
                      {port.protocol.toUpperCase()}
                    </span>
                  </TD>
                  <TD numeric>
                    <MonoValue value={String(port.published)} />
                  </TD>
                  <TD numeric>
                    <MonoValue value={String(port.target)} />
                  </TD>
                  <TD className="w-0 whitespace-nowrap">
                    <span className="flex justify-end gap-1">
                      <Tooltip content={t("ports.edit")}>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={t("ports.edit")}
                          onClick={() => setPending({ kind: "edit", index, port })}
                        >
                          <Pencil aria-hidden="true" className="size-4" />
                        </Button>
                      </Tooltip>
                      <Tooltip content={t("ports.delete")}>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={t("ports.delete")}
                          onClick={() => setPending({ kind: "delete", index, port })}
                        >
                          <Trash2 aria-hidden="true" className="size-4" />
                        </Button>
                      </Tooltip>
                    </span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <div className="flex flex-wrap gap-2">
            {add}
            <Button variant="ghost" onClick={() => setPending({ kind: "deleteAll" })}>
              {t("ports.deleteAll")}
            </Button>
          </div>
        </>
      )}

      {(pending?.kind === "create" || pending?.kind === "edit") && (
        <PortDialog
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
        title={t("ports.deleteDialog.title")}
        description={
          pending?.kind === "delete"
            ? t("ports.deleteDialog.description", {
                port: `${pending.port.protocol.toUpperCase()} ${pending.port.published}`,
              })
            : undefined
        }
        confirmLabel={t("ports.deleteDialog.confirm")}
        onConfirm={async () => {
          if (pending?.kind === "delete") {
            await advancedApi.removePort(project, service, pending.index);
            await refresh();
            toast.success(t("ports.deleted"), t("savedHint"));
          }
        }}
      />
      <ConfirmDialog
        open={pending?.kind === "deleteAll"}
        onOpenChange={(open) => !open && close()}
        title={t("ports.deleteAllDialog.title")}
        description={t("ports.deleteAllDialog.description")}
        confirmLabel={t("ports.deleteAllDialog.confirm")}
        onConfirm={async () => {
          await advancedApi.removeAllPorts(project, service);
          await refresh();
          toast.success(t("ports.deletedAll"), t("savedHint"));
        }}
      />
    </div>
  );
}
