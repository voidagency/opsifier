import { firstInvalidEnvLine } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { errorMessage, useForm } from "../../../../lib/forms";
import { Button, CodeEditor, FormBanner, Skeleton, toast } from "../../../../ui";
import { environmentQuery, servicesApi, useServiceParams } from "../../api";
import { EnvFileForm } from "../source/EnvFileForm";

function EnvironmentForm({
  project,
  service,
  initial,
}: {
  project: string;
  service: string;
  initial: string;
}) {
  const { t } = useTranslation("service-environment");
  const form = useForm({
    t,
    initialValues: { env: initial },
    validate: ({ env }) => {
      const line = firstInvalidEnvLine(env);
      return line === null ? {} : { env: t("invalidLine", { line }) };
    },
    onSubmit: async ({ env }) => {
      await servicesApi.saveEnvironment(project, service, env);
      toast.success(t("saved"), t("savedHint"));
    },
  });

  return (
    <form onSubmit={form.handleSubmit} noValidate className="grid max-w-[720px] gap-4">
      {form.banner && <FormBanner>{form.banner}</FormBanner>}
      {form.errors.env && <FormBanner>{form.errors.env}</FormBanner>}
      <CodeEditor
        value={form.values.env}
        onChange={(value) => form.set("env", value)}
        label={t("title")}
        invalid={form.errors.env !== undefined}
      />
      <div>
        <Button type="submit" variant="primary" pending={form.pending}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

export function EnvironmentTab() {
  const { t } = useTranslation(["service-environment", "common"]);
  const { project, service } = useServiceParams();
  const { data, isPending, isError, error, refetch } = useQuery(environmentQuery(project, service));

  return (
    <section className="grid gap-x-10 gap-y-4 px-4 py-6 md:px-6 lg:grid-cols-[minmax(0,260px)_minmax(0,720px)] lg:px-8">
      <div>
        <h2 className="text-md font-medium">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted">{t("description")}</p>
      </div>
      {isPending ? (
        <Skeleton className="h-52" />
      ) : isError ? (
        <div className="grid justify-items-start gap-3">
          <FormBanner>{errorMessage(error, t)}</FormBanner>
          <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
        </div>
      ) : (
        <div className="grid gap-6">
          <EnvironmentForm key={service} project={project} service={service} initial={data.env} />
          <EnvFileForm project={project} service={service} />
        </div>
      )}
    </section>
  );
}
