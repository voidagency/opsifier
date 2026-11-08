import { envFilePath } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useForm } from "../../../../lib/forms";
import { Button, Field, FormBanner, Input, Switch, toast } from "../../../../ui";
import { serviceQuery } from "../../api";
import { envFileQuery, sourceApi } from "./api";

function EnvFileFields({
  project,
  service,
  path,
}: {
  project: string;
  service: string;
  path: string | null;
}) {
  const { t } = useTranslation("service-environment");
  const queryClient = useQueryClient();
  const form = useForm({
    t,
    initialValues: { enabled: path !== null, path: path ?? ".env" },
    validate: (values) =>
      values.enabled && !envFilePath.safeParse(values.path).success ? { path: t("file.pathInvalid") } : {},
    onSubmit: async (values) => {
      const saved = await sourceApi.saveEnvFile(project, service, {
        path: values.enabled ? values.path : null,
      });
      queryClient.setQueryData(envFileQuery(project, service).queryKey, saved);
      toast.success(t("file.saved"), t("savedHint"));
    },
  });

  return (
    <form onSubmit={form.handleSubmit} noValidate className="grid max-w-[520px] gap-3 border-t pt-4">
      {form.banner && <FormBanner>{form.banner}</FormBanner>}
      <Switch
        label={t("file.label")}
        hint={t("file.hint")}
        checked={form.values.enabled}
        onCheckedChange={(checked) => form.set("enabled", checked)}
      />
      {form.values.enabled && (
        <Field label={t("file.path")} hint={t("file.pathHint")} error={form.errors.path}>
          <Input {...form.field("path")} mono autoComplete="off" spellCheck={false} placeholder=".env" />
        </Field>
      )}
      <div>
        <Button type="submit" pending={form.pending}>
          {t("file.submit")}
        </Button>
      </div>
    </form>
  );
}

/** Writes the variables into the source tree before each build. There is no such tree for an image. */
export function EnvFileForm({ project, service }: { project: string; service: string }) {
  const { data: detail } = useQuery(serviceQuery(project, service));
  const { data } = useQuery({ ...envFileQuery(project, service), retry: false });

  if (
    detail === undefined ||
    detail.source === null ||
    detail.source.type === "image" ||
    data === undefined
  ) {
    return null;
  }
  return <EnvFileFields key={data.path} project={project} service={service} path={data.path} />;
}
