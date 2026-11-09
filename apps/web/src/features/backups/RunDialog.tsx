import type { BackupConfigEntry } from "@opsifier/contract";
import { useTranslation } from "react-i18next";
import { useForm } from "../../lib/forms";
import { Button, Dialog, Field, FormBanner, Input, toast } from "../../ui";
import { useActionFollower } from "../services/ActionFollower";
import { backupsApi } from "./api";

export interface RunDialogProps {
  project: string;
  service: string;
  config: BackupConfigEntry;
  onClose: () => void;
  onStarted: () => Promise<unknown>;
}

/** Takes a backup right now, with an optional name shown in the history. */
export function RunDialog({ project, service, config, onClose, onStarted }: RunDialogProps) {
  const { t } = useTranslation(["backups", "common"]);
  const follow = useActionFollower();

  const form = useForm({
    t,
    initialValues: { name: "" },
    validate: ({ name }) => (name.length > 80 ? { name: t("errors.runName") } : {}),
    onSubmit: async ({ name }) => {
      const action = await backupsApi.run(project, service, config.id, { name });
      follow(action.id, {
        success: () => toast.success(t("run.done")),
        failure: (ended) => toast.error(t("run.failed"), ended.error ?? undefined),
      });
      toast({ title: t("run.started") });
      await onStarted();
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !form.pending && onClose()}
      size="sm"
      title={t("run.title")}
      description={t("run.description", { target: config.databaseName ?? config.volumeName ?? "" })}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={form.pending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("run.submit")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("run.name")} hint={t("run.nameHint")} error={form.errors.name} optional>
          <Input {...form.field("name")} autoComplete="off" />
        </Field>
      </div>
    </Dialog>
  );
}
