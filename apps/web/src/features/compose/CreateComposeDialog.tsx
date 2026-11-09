import { createComposeRequest } from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "../../lib/forms";
import { Button, Dialog, Field, FormBanner, Input, toast } from "../../ui";
import { projectsKey } from "../projects/api";
import { composeApi } from "./api";

export function CreateComposeDialog({
  project,
  open,
  onOpenChange,
}: {
  project: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["compose", "services", "common"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const form = useForm({
    t,
    initialValues: { name: "" },
    validate: ({ name }) => {
      const parsed = createComposeRequest.safeParse({ name });
      if (parsed.success) {
        return {};
      }
      return { name: name === "" ? t("services:create.required") : t("services:create.invalid") };
    },
    onSubmit: async ({ name }) => {
      await composeApi.create(project, { name });
      await queryClient.invalidateQueries({ queryKey: projectsKey });
      onOpenChange(false);
      toast.success(t("create.created", { name }));
      await navigate({
        to: "/projects/$project/compose/$service/source",
        params: { project, service: name },
      });
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts from a clean form
  useEffect(() => {
    if (open) {
      form.reset({ name: "" });
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={t("create.title")}
      description={t("create.description", { project })}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("create.submit")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field
          label={t("services:create.name")}
          hint={t("services:create.nameHint")}
          error={form.errors.name}
        >
          <Input {...form.field("name")} mono autoFocus autoComplete="off" spellCheck={false} />
        </Field>
      </div>
    </Dialog>
  );
}
