import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import {
  Button,
  ConfirmDialog,
  CopyButton,
  ErrorState,
  FormBanner,
  MonoValue,
  PageHeader,
  Pictogram,
  type PictogramName,
  RetentionSummary,
  SectionIntro,
  Skeleton,
  toast,
  useDocumentTitle,
} from "../../ui";
import { useCurrentUser } from "../auth/session";
import { VariablesEditor } from "../services/tabs/environment/VariablesEditor";
import { projectEnvQuery, projectQuery, projectSchemaQuery, projectsApi, projectsKey } from "./api";
import { ProjectAccess } from "./ProjectAccess";

const route = getRouteApi("/app/projects/$project/settings");

function Section({
  pictogram,
  title,
  description,
  children,
}: {
  pictogram: PictogramName;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-x-10 gap-y-4 border-b px-4 py-6 last:border-b-0 md:px-6 lg:grid-cols-[minmax(0,260px)_minmax(0,640px)] lg:px-8">
      <SectionIntro pictogram={pictogram} title={title} description={description} />
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function EnvironmentSection({ project }: { project: string }) {
  const { t } = useTranslation(["projects", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(projectEnvQuery(project));

  if (isPending || isError) {
    return (
      <Section
        pictogram="environment"
        title={t("settings.env.title")}
        description={t("settings.env.description")}
      >
        {isPending ? (
          <Skeleton className="h-32" />
        ) : (
          <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
        )}
      </Section>
    );
  }
  return (
    <Section
      pictogram="environment"
      title={t("settings.env.title")}
      description={t("settings.env.description")}
    >
      <VariablesEditor
        key={project}
        names={data.names}
        label={t("settings.env.title")}
        submitLabel={t("settings.env.submit")}
        savedTitle={t("settings.env.saved")}
        savedHint={t("settings.env.savedHint")}
        reveal={() => projectsApi.revealEnv(project)}
        save={(env) => projectsApi.saveEnv(project, env)}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ["projects", project, "env"] });
        }}
      />
    </Section>
  );
}

function SchemaSection({ project }: { project: string }) {
  const { t } = useTranslation(["projects", "common"]);
  const { data, isPending, isError, error, refetch } = useQuery(projectSchemaQuery(project));
  const text = data === undefined ? "" : JSON.stringify(data, null, 2);

  return (
    <Section
      pictogram="template"
      title={t("settings.schema.title")}
      description={t("settings.schema.description")}
    >
      {isPending ? (
        <Skeleton className="h-24" />
      ) : isError ? (
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      ) : (
        <div className="relative">
          <pre
            data-testid="project-schema"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: it scrolls, so the keyboard has to reach it
            tabIndex={0}
            className="max-h-[450px] overflow-auto rounded-sm border bg-raised p-3 pr-10 font-mono text-xs"
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
    <Section pictogram="maintenance" title={t("settings.danger.title")}>
      <div className="grid justify-items-start gap-3">
        <p className="max-w-[60ch] text-sm text-muted">{t("settings.danger.description")}</p>
        {serviceCount > 0 && (
          <FormBanner tone="warning">{t("settings.danger.warning", { count: serviceCount })}</FormBanner>
        )}
        <Button
          variant="danger"
          disabled={data === undefined || serviceCount > 0}
          onClick={() => setOpen(true)}
        >
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
      >
        <RetentionSummary removed={t("settings.danger.removed")} kept={t("settings.danger.kept")} />
      </ConfirmDialog>
    </Section>
  );
}

export function ProjectSettingsPage() {
  const { t } = useTranslation("projects");
  const { project } = route.useParams();
  // Who reaches a project is account administration, which only administrators can see or change.
  const administrator = useCurrentUser()?.role === "admin";
  useDocumentTitle(t("settings.pageTitle", { name: project }));

  return (
    <>
      <PageHeader
        leading={<Pictogram name="settings" size={24} className="mt-1 text-muted" />}
        title={t("settings.pageTitle", { name: project })}
        description={t("settings.pageDescription")}
      />
      <EnvironmentSection project={project} />
      <SchemaSection project={project} />
      {administrator && (
        <Section
          pictogram="access"
          title={t("settings.access.title")}
          description={t("settings.access.description")}
        >
          <ProjectAccess project={project} />
        </Section>
      )}
      <DangerSection project={project} />
    </>
  );
}
