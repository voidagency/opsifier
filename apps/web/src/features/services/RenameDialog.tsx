import { renameServiceRequest } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "../../lib/forms";
import { Button, Dialog, Field, FormBanner, Input, Select, toast } from "../../ui";
import { projectsKey, projectsQuery } from "../projects/api";
import { serviceKey, servicesApi } from "./api";

export function RenameDialog({
  project,
  service,
  open,
  onOpenChange,
}: {
  project: string;
  service: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("services");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery(projectsQuery);
  const initial = { projectName: project, name: service };

  const form = useForm({
    t,
    initialValues: initial,
    validate: (values) => {
      const parsed = renameServiceRequest.safeParse(values);
      if (parsed.success) {
        return {};
      }
      return { name: values.name === "" ? t("create.required") : t("create.invalid") };
    },
    onSubmit: async (values) => {
      await servicesApi.rename(project, service, values);
      queryClient.removeQueries({ queryKey: serviceKey(project, service) });
      await queryClient.invalidateQueries({ queryKey: projectsKey });
      onOpenChange(false);
      toast.success(t("rename.done", { name: values.name }));
      await navigate({
        to: "/projects/$project/app/$service/",
        params: { project: values.projectName, service: values.name },
        replace: true,
      });
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts from the current name
  useEffect(() => {
    if (open) {
      form.reset(initial);
    }
  }, [open]);

  const options = (data?.projects ?? [{ name: project }]).map((item) => ({
    value: item.name,
    label: <span className="font-mono">{item.name}</span>,
  }));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={t("rename.title")}
      description={t("rename.description")}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("rename.submit")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("rename.project")}>
          <Select
            value={form.values.projectName}
            onValueChange={(value) => form.set("projectName", value)}
            options={options}
          />
        </Field>
        <Field label={t("rename.name")} hint={t("create.nameHint")} error={form.errors.name}>
          <Input {...form.field("name")} mono autoComplete="off" spellCheck={false} />
        </Field>
      </div>
    </Dialog>
  );
}
