import { type ScriptSpec, scriptSpec } from "@opsifier/contract";
import { useTranslation } from "react-i18next";
import { schemaErrors, useForm } from "../../../../lib/forms";
import { Button, CodeEditor, Dialog, Field, FormBanner, Input, toast } from "../../../../ui";
import { scriptsApi } from "./api";

export interface ScriptDialogProps {
  project: string;
  service: string;
  /** The script being edited with its position, or undefined to create one. */
  editing?: { index: number; script: ScriptSpec };
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}

export function ScriptDialog({ project, service, editing, onClose, onSaved }: ScriptDialogProps) {
  const { t } = useTranslation(["service-scripts", "common"]);
  const form = useForm({
    t,
    initialValues: { name: editing?.script.name ?? "", script: editing?.script.script ?? "" },
    validate: (values) =>
      schemaErrors<"name" | "script">(scriptSpec, values, {
        name: t("errors.name"),
        script: t("errors.script"),
      }),
    onSubmit: async (values) => {
      if (editing === undefined) {
        await scriptsApi.add(project, service, values);
      } else {
        await scriptsApi.update(project, service, editing.index, values);
      }
      await onSaved();
      toast.success(t("saved"));
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title={editing === undefined ? t("dialog.createTitle") : t("dialog.updateTitle")}
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
        <Field label={t("dialog.name")} error={form.errors.name}>
          <Input {...form.field("name")} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label={t("dialog.script")} hint={t("dialog.scriptHint")} error={form.errors.script}>
          <CodeEditor
            value={form.values.script}
            onChange={(value) => form.set("script", value)}
            label={t("dialog.script")}
            language="plain"
            invalid={form.errors.script !== undefined}
          />
        </Field>
      </div>
    </Dialog>
  );
}
