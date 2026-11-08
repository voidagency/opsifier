import { firstInvalidEnvLine } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, useForm } from "../../lib/forms";
import {
  Button,
  CodeEditor,
  ConfirmDialog,
  CopyButton,
  FormBanner,
  MonoValue,
  PageHeader,
  Skeleton,
  toast,
  useDocumentTitle,
} from "../../ui";
import { projectEnvQuery, projectQuery, projectSchemaQuery, projectsApi, projectsKey } from "./api";

const route = getRouteApi("/app/projects/$project/settings");

function Section({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-x-10 gap-y-4 border-b px-4 py-6 last:border-b-0 md:px-6 lg:grid-cols-[minmax(0,260px)_minmax(0,640px)] lg:px-8">
      <div>
        <h2 className="text-md font-medium">{title}</h2>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function EnvironmentSection({ project }: { project: string }) {
  const { t } = useTranslation(["projects", "common"]);
  const { data, isPending, isError, error, refetch } = useQuery(projectEnvQuery(project));

  if (isPending) {
    return (
      <Section title={t("settings.env.title")} description={t("settings.env.description")}>
        <Skeleton className="h-32" />
      </Section>
    );
  }
  if (isError) {
    return (
      <Section title={t("settings.env.title")} description={t("settings.env.description")}>
        <div className="grid justify-items-start gap-3">
          <FormBanner>{errorMessage(error, t)}</FormBanner>
          <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
        </div>
      </Section>
    );
  }
  return <EnvironmentForm key={project} project={project} initial={data.env} />;
}

function EnvironmentForm({ project, initial }: { project: string; initial: string }) {
  const { t } = useTranslation(["projects", "common"]);
  const form = useForm({
    t,
    initialValues: { env: initial },
    validate: ({ env }) => {
      const line = firstInvalidEnvLine(env);
      return line === null ? {} : { env: t("settings.env.invalidLine", { line }) };
    },
    onSubmit: async ({ env }) => {
      await projectsApi.saveEnv(project, env);
      toast.success(t("settings.env.saved"), t("settings.env.savedHint"));
    },
  });

  return (
    <Section title={t("settings.env.title")} description={t("settings.env.description")}>
      <form onSubmit={form.handleSubmit} noValidate className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        {form.errors.env && <FormBanner>{form.errors.env}</FormBanner>}
        <CodeEditor
          value={form.values.env}
          onChange={(value) => form.set("env", value)}
          label={t("settings.env.title")}
          invalid={form.errors.env !== undefined}
        />
        <div>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("settings.env.submit")}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function SchemaSection({ project }: { project: string }) {
  const { t } = useTranslation(["projects", "common"]);
  const { data, isPending, isError, error, refetch } = useQuery(projectSchemaQuery(project));
  const text = data === undefined ? "" : JSON.stringify(data, null, 2);

  return (
    <Section title={t("settings.schema.title")} description={t("settings.schema.description")}>
      {isPending ? (
        <Skeleton className="h-24" />
      ) : isError ? (
        <div className="grid justify-items-start gap-3">
          <FormBanner>{errorMessage(error, t)}</FormBanner>
          <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
        </div>
      ) : (
        <div className="relative">
          <pre
            data-testid="project-schema"
            className="max-h-[360px] overflow-auto rounded-sm border bg-raised p-3 pr-10 font-mono text-xs"
          >
            {text}
          </pre>
          <span className="absolute top-1.5 right-1.5">
            <CopyButton value={text} label={t("settings.schema.copy")} />
          </span>
        </div>
      )}
    </Section>
  );
}

function DangerSection({ project }: { project: string }) {
  const { t } = useTranslation(["projects", "common"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery(projectQuery(project));
  const [open, setOpen] = useState(false);
  const serviceCount = data?.services.length ?? 0;

  const destroy = async () => {
    await projectsApi.destroy(project, project);
    await queryClient.invalidateQueries({ queryKey: projectsKey });
    toast({ title: t("settings.danger.destroying", { name: project }) });
    await navigate({ to: "/" });
  };

  return (
    <Section title={t("settings.danger.title")} description={t("settings.danger.description")}>
      <div className="grid justify-items-start gap-3">
        {serviceCount > 0 && (
          <FormBanner tone="warning">{t("settings.danger.warning", { count: serviceCount })}</FormBanner>
        )}
        <Button variant="danger" onClick={() => setOpen(true)}>
          {t("settings.danger.destroy")}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t("settings.danger.dialogTitle")}
        description={
          <>
            {t("settings.danger.dialogDescription")}{" "}
            <MonoValue value={project} copy copyLabel={t("settings.danger.copyName")} />
          </>
        }
        confirmLabel={t("settings.danger.confirm")}
        confirmText={project}
        onConfirm={destroy}
      />
    </Section>
  );
}

export function ProjectSettingsPage() {
  const { t } = useTranslation("projects");
  const { project } = route.useParams();
  useDocumentTitle(t("settings.pageTitle", { name: project }));

  return (
    <>
      <PageHeader
        title={t("settings.pageTitle", { name: project })}
        description={t("settings.pageDescription")}
      />
      <EnvironmentSection project={project} />
      <SchemaSection project={project} />
      <DangerSection project={project} />
    </>
  );
}
