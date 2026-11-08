import {
  bindMountSpec,
  fileMountSpec,
  type MountEntry,
  type MountSpec,
  volumeMountSpec,
} from "@opsifier/contract";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isApiError } from "../../../../lib/api";
import { schemaErrors, useForm } from "../../../../lib/forms";
import { Button, CodeEditor, ConfirmDialog, Dialog, Field, FormBanner, Input, toast } from "../../../../ui";
import { storageApi } from "./api";

export type MountKind = MountSpec["type"];

const RISK_CODES = ["mount_exposes_docker_socket", "mount_exposes_data_directory"] as const;
type RiskCode = (typeof RISK_CODES)[number];

const isRiskCode = (code: string): code is RiskCode => (RISK_CODES as readonly string[]).includes(code);

export interface MountDialogProps {
  project: string;
  service: string;
  kind: MountKind;
  /** The mount being edited with its position, or undefined to create one. */
  editing?: { index: number; mount: MountEntry };
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}

type Values = { hostPath: string; name: string; mountPath: string; content: string };

function initialValues(mount: MountEntry | undefined): Values {
  return {
    hostPath: mount?.type === "bind" ? mount.hostPath : "",
    name: mount?.type === "volume" ? mount.name : "",
    mountPath: mount?.mountPath ?? "",
    content: mount?.type === "file" ? mount.content : "",
  };
}

function buildMount(kind: MountKind, values: Values, acknowledgeRisk: boolean): MountSpec {
  switch (kind) {
    case "bind":
      return { type: "bind", hostPath: values.hostPath, mountPath: values.mountPath, acknowledgeRisk };
    case "volume":
      return { type: "volume", name: values.name, mountPath: values.mountPath };
    case "file":
      return { type: "file", mountPath: values.mountPath, content: values.content };
  }
}

const schemas = { bind: bindMountSpec, volume: volumeMountSpec, file: fileMountSpec } as const;

export function MountDialog({ project, service, kind, editing, onClose, onSaved }: MountDialogProps) {
  const { t } = useTranslation(["service-storage", "common"]);
  const [riskCode, setRiskCode] = useState<RiskCode | null>(null);
  // An edit that keeps the same dangerous path keeps its confirmation.
  const confirmed =
    editing?.mount.type === "bind" && editing.mount.risk !== null ? editing.mount.hostPath : null;

  const save = async (mount: MountSpec) => {
    if (editing === undefined) {
      await storageApi.add(project, service, mount);
    } else {
      await storageApi.update(project, service, editing.index, mount);
    }
    await onSaved();
    toast.success(editing === undefined ? t("created") : t("updated"), t("savedHint"));
    onClose();
  };

  const form = useForm<Values>({
    t,
    initialValues: initialValues(editing?.mount),
    validate: (values) =>
      schemaErrors<keyof Values & string>(
        schemas[kind],
        { ...buildMount(kind, values, false) },
        {
          hostPath: t("errors.hostPath"),
          mountPath: t("errors.mountPath"),
          name: t("errors.name"),
          content: t("errors.content"),
        },
      ),
    onSubmit: async (values) => {
      try {
        await save(buildMount(kind, values, values.hostPath === confirmed));
      } catch (error) {
        if (isApiError(error) && isRiskCode(error.code)) {
          setRiskCode(error.code);
          return;
        }
        throw error;
      }
    },
  });

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => !open && onClose()}
        size={kind === "file" ? "lg" : "md"}
        title={editing === undefined ? t(`dialog.${kind}.createTitle`) : t(`dialog.${kind}.updateTitle`)}
        onSubmit={form.handleSubmit}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={form.pending}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" variant="primary" pending={form.pending}>
              {editing === undefined ? t("dialog.create") : t("dialog.save")}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {form.banner && <FormBanner>{form.banner}</FormBanner>}
          {kind === "bind" && (
            <Field label={t("dialog.hostPath")} hint={t("dialog.hostPathHint")} error={form.errors.hostPath}>
              <Input
                {...form.field("hostPath")}
                mono
                autoComplete="off"
                spellCheck={false}
                placeholder="/srv/app"
              />
            </Field>
          )}
          {kind === "volume" && (
            <Field label={t("dialog.name")} hint={t("dialog.nameHint")} error={form.errors.name}>
              <Input {...form.field("name")} mono autoComplete="off" spellCheck={false} placeholder="data" />
            </Field>
          )}
          <Field label={t("dialog.mountPath")} error={form.errors.mountPath}>
            <Input
              {...form.field("mountPath")}
              mono
              autoComplete="off"
              spellCheck={false}
              placeholder="/data"
            />
          </Field>
          {kind === "file" && (
            <Field label={t("dialog.content")} optional error={form.errors.content}>
              <CodeEditor
                value={form.values.content}
                onChange={(value) => form.set("content", value)}
                label={t("dialog.content")}
                language="plain"
                invalid={form.errors.content !== undefined}
              />
            </Field>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={riskCode !== null}
        onOpenChange={(open) => !open && setRiskCode(null)}
        title={t("risk.title")}
        description={riskCode === null ? undefined : t(`risk.${riskCode}`)}
        confirmLabel={t("risk.confirm")}
        onConfirm={async () => {
          await save(buildMount(kind, form.values, true));
          setRiskCode(null);
        }}
      />
    </>
  );
}
