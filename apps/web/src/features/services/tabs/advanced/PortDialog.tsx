import { type PortSpec, portSpec } from "@opsifier/contract";
import { useTranslation } from "react-i18next";
import { schemaErrors, useForm } from "../../../../lib/forms";
import { Button, Dialog, Field, FormBanner, Input, Select, toast } from "../../../../ui";
import { advancedApi } from "./api";

export interface PortDialogProps {
  project: string;
  service: string;
  editing?: { index: number; port: PortSpec };
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}

const toPort = (values: { protocol: string; published: string; target: string }): PortSpec => ({
  protocol: values.protocol as PortSpec["protocol"],
  published: values.published.trim() === "" ? Number.NaN : Number(values.published),
  target: values.target.trim() === "" ? Number.NaN : Number(values.target),
});

export function PortDialog({ project, service, editing, onClose, onSaved }: PortDialogProps) {
  const { t } = useTranslation(["service-advanced", "common"]);
  const form = useForm({
    t,
    initialValues: {
      protocol: (editing?.port.protocol ?? "tcp") as string,
      published: editing === undefined ? "" : String(editing.port.published),
      target: editing === undefined ? "" : String(editing.port.target),
    },
    validate: (values) =>
      schemaErrors<"protocol" | "published" | "target">(portSpec, toPort(values), {
        published: t("errors.port"),
        target: t("errors.port"),
      }),
    onSubmit: async (values) => {
      const port = toPort(values);
      if (editing === undefined) {
        await advancedApi.addPort(project, service, port);
      } else {
        await advancedApi.updatePort(project, service, editing.index, port);
      }
      await onSaved();
      toast.success(editing === undefined ? t("ports.created") : t("ports.updated"), t("savedHint"));
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="sm"
      title={editing === undefined ? t("ports.dialog.createTitle") : t("ports.dialog.updateTitle")}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={form.pending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {editing === undefined ? t("ports.dialog.create") : t("ports.dialog.save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("ports.protocol")}>
          <Select
            value={form.values.protocol}
            onValueChange={(value) => form.set("protocol", value)}
            options={[
              { value: "tcp", label: "TCP" },
              { value: "udp", label: "UDP" },
            ]}
          />
        </Field>
        <Field label={t("ports.published")} hint={t("ports.publishedHint")} error={form.errors.published}>
          <Input {...form.field("published")} mono type="number" />
        </Field>
        <Field label={t("ports.target")} hint={t("ports.targetHint")} error={form.errors.target}>
          <Input {...form.field("target")} mono type="number" />
        </Field>
      </div>
    </Dialog>
  );
}
