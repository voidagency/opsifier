import { serviceNotes } from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "../../lib/forms";
import { Button, Dialog, Field, FormBanner, Textarea, toast } from "../../ui";
import { serviceKey, servicesApi } from "./api";

export function NotesDialog({
  project,
  service,
  notes,
  open,
  onOpenChange,
}: {
  project: string;
  service: string;
  notes: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("services");
  const queryClient = useQueryClient();

  const form = useForm({
    t,
    initialValues: { notes },
    validate: (values) => (serviceNotes.safeParse(values).success ? {} : { notes: t("notes.tooLong") }),
    onSubmit: async (values) => {
      await servicesApi.saveNotes(project, service, values.notes);
      await queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
      onOpenChange(false);
      toast.success(t("notes.saved"));
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening shows what is stored now
  useEffect(() => {
    if (open) {
      form.reset({ notes });
    }
  }, [open, notes]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("notes.title")}
      description={t("notes.description")}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("notes.save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("notes.label")} error={form.errors.notes}>
          <Textarea {...form.field("notes")} rows={10} mono />
        </Field>
      </div>
    </Dialog>
  );
}
