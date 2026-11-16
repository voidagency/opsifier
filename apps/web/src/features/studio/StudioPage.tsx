import type { ServiceStatus, StudioApp } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Boxes, Link2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, useForm } from "../../lib/forms";
import {
  Button,
  buttonClass,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormBanner,
  Input,
  Lamp,
  PageHeader,
  Select,
  Skeleton,
  Tooltip,
  toast,
} from "../../ui";
import { useCurrentUser } from "../auth/session";
import { projectsQuery } from "../projects/api";
import { studioApi, studioAppName, studioKey, studioOverviewQuery } from "./api";

type LampState = "running" | "stopped" | "progress" | "failed" | "unknown";
const lampOf: Record<ServiceStatus, LampState> = {
  running: "running",
  stopped: "stopped",
  starting: "progress",
  failing: "failed",
  undeployed: "stopped",
  unknown: "unknown",
};

/** The projects linked to the Studio: open one to talk to the agent about it and see it live. */
export function StudioPage() {
  const { t } = useTranslation(["studio", "common"]);
  const user = useCurrentUser();
  const admin = user?.role === "admin";
  const { data, isPending, isError, error, refetch } = useQuery({
    ...studioOverviewQuery,
    enabled: user !== null && user !== undefined,
  });
  const [linking, setLinking] = useState(false);
  const [adding, setAdding] = useState(false);

  const body = () => {
    if (isPending) {
      return <Skeleton className="h-32" />;
    }
    if (isError) {
      return <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />;
    }
    if (!admin && (!data.enabled || data.apps.length === 0)) {
      // Someone a project is shared with: there is nothing to set up from here.
      return (
        <EmptyState
          illustration="no-projects"
          title={t(data.enabled ? "list.memberEmptyTitle" : "setup.memberOffTitle")}
          description={t(data.enabled ? "list.memberEmptyDescription" : "setup.memberOffDescription")}
        />
      );
    }
    if (!data.enabled || !data.agentConfigured) {
      return (
        <EmptyState
          illustration="no-projects"
          title={t(data.enabled ? "setup.agentTitle" : "setup.offTitle")}
          description={t("setup.description")}
          action={
            <Link to="/settings/server/studio" className={buttonClass("primary")}>
              {t("setup.action")}
            </Link>
          }
        />
      );
    }
    if (data.apps.length === 0) {
      return (
        <EmptyState
          illustration="no-projects"
          title={t("list.emptyTitle")}
          description={t(data.canAddProjects ? "list.emptyDescription" : "list.emptyNoFolder")}
          action={
            data.canAddProjects ? (
              <Button variant="primary" onClick={() => setAdding(true)}>
                {t("add.action")}
              </Button>
            ) : (
              <Link to="/settings/server/studio" className={buttonClass("primary")}>
                {t("setup.action")}
              </Link>
            )
          }
        />
      );
    }
    return (
      <ul className="max-w-[1100px] border-y">
        {data.apps.map((app) => (
          <AppRow key={`${app.project}/${app.service}`} app={app} />
        ))}
      </ul>
    );
  };

  return (
    <div className="grid gap-4 px-4 py-6 md:px-6 lg:px-8">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          admin && data?.enabled === true ? (
            <div className="flex flex-wrap gap-2">
              <Button icon={<Link2 aria-hidden="true" className="size-4" />} onClick={() => setLinking(true)}>
                {t("link.action")}
              </Button>
              {data.canAddProjects && (
                <Button
                  variant="primary"
                  icon={<Plus aria-hidden="true" className="size-4" />}
                  onClick={() => setAdding(true)}
                >
                  {t("add.action")}
                </Button>
              )}
            </div>
          ) : undefined
        }
      />
      {body()}
      {linking && <LinkDialog onClose={() => setLinking(false)} />}
      {adding && <AddProjectDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function AppRow({ app }: { app: StudioApp }) {
  const { t } = useTranslation(["studio", "common"]);
  const admin = useCurrentUser()?.role === "admin";
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState(false);
  const last = app.lastConversation;
  const name = studioAppName(app);
  const remove = async () => {
    await studioApi.remove(app.project, app.service, name);
    toast.success(t("remove.started", { name }));
    await queryClient.invalidateQueries({ queryKey: studioKey });
  };
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b py-3 last:border-b-0">
      <Lamp state={lampOf[app.previewStatus]} size="xs" label={t(`preview.status.${app.previewStatus}`)} />
      <span className="grid min-w-0 gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2">
          <span className="truncate font-medium">{name}</span>
          {app.agentMode === "missing" && (
            <span className="rounded-sm border px-1.5 text-xs text-muted">{t("list.agentMissing")}</span>
          )}
        </span>
        <span className="truncate text-xs text-muted">
          {last === null
            ? t("list.noConversation", { project: app.project })
            : t("list.lastConversation", {
                project: app.project,
                title: last.title ?? t("list.untitled"),
                date: new Date(last.updatedAt).toLocaleString(),
              })}
        </span>
      </span>
      <span className="flex items-center gap-1">
        <Link
          to="/studio/$project/$service"
          params={{ project: app.project, service: app.service }}
          search={{}}
          className={buttonClass("secondary", "sm")}
          aria-label={t("list.openNamed", { name })}
        >
          {t("list.open")}
        </Link>
        {admin && (
          // Where its preview and agent server live, with their logs, settings and deployments.
          <Tooltip content={t("list.inOpsifier", { project: app.project })}>
            <Link
              to="/projects/$project"
              params={{ project: app.project }}
              className={buttonClass("ghost", "icon-sm")}
              aria-label={t("list.inOpsifier", { project: app.project })}
            >
              <Boxes aria-hidden="true" className="size-4" />
            </Link>
          </Tooltip>
        )}
        {admin && (
          <Tooltip content={t("remove.action", { name })}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("remove.action", { name })}
              onClick={() => setRemoving(true)}
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </Button>
          </Tooltip>
        )}
      </span>
      {admin && (
        <ConfirmDialog
          open={removing}
          onOpenChange={setRemoving}
          title={t("remove.title", { name })}
          description={t("remove.description")}
          confirmLabel={t("remove.confirm")}
          confirmText={name}
          onConfirm={remove}
        />
      )}
    </li>
  );
}

/** Links a service whose container shows a project's live preview, with the folder the agent works in. */
function LinkDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["studio", "common"]);
  const queryClient = useQueryClient();
  const projects = useQuery(projectsQuery);
  const options = (projects.data?.projects ?? []).flatMap((project) =>
    project.services.map((service) => ({
      value: `${project.name}/${service.name}`,
      label: `${project.name} / ${service.name}`,
    })),
  );
  const form = useForm({
    t,
    initialValues: { service: "", workspaceDir: "" },
    validate: (values) => ({
      ...(values.service === "" ? { service: t("link.serviceRequired") } : {}),
      ...(values.workspaceDir.startsWith("/") ? {} : { workspaceDir: t("link.folderRequired") }),
    }),
    onSubmit: async (values) => {
      const [project = "", service = ""] = values.service.split("/");
      await studioApi.link(project, service, { workspaceDir: values.workspaceDir });
      await queryClient.invalidateQueries({ queryKey: studioKey });
      toast.success(t("link.done", { name: service }));
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="sm"
      title={t("link.title")}
      description={t("link.description")}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={form.pending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("link.submit")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("link.service")} hint={t("link.serviceHint")} error={form.errors.service}>
          <Select
            value={form.values.service === "" ? undefined : form.values.service}
            onValueChange={(value) => form.set("service", value)}
            options={options}
            placeholder={t("link.servicePlaceholder")}
          />
        </Field>
        <Field label={t("link.folder")} hint={t("link.folderHint")} error={form.errors.workspaceDir}>
          <Input
            {...form.field("workspaceDir")}
            mono
            placeholder="/projects/mon-projet"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      </div>
    </Dialog>
  );
}

/**
 * Adds a GitHub project: the panel copies it into the projects folder with the agent server's own
 * GitHub token, makes its preview and links it, then opens it. The copy can take a minute.
 */
function AddProjectDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["studio", "common"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const form = useForm({
    t,
    initialValues: { repository: "", branch: "" },
    validate: (values) => ({
      ...(values.repository.trim() === "" ? { repository: t("add.repositoryRequired") } : {}),
    }),
    onSubmit: async (values) => {
      const added = await studioApi.addProject({
        repository: values.repository.trim(),
        ...(values.branch.trim() === "" ? {} : { branch: values.branch.trim() }),
      });
      await queryClient.invalidateQueries({ queryKey: studioKey });
      toast.success(t("add.done", { name: added.service }));
      onClose();
      await navigate({
        to: "/studio/$project/$service",
        params: { project: added.project, service: added.service },
        search: {},
      });
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !form.pending && onClose()}
      size="sm"
      title={t("add.title")}
      description={t("add.description")}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={form.pending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("add.submit")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("add.repository")} hint={t("add.repositoryHint")} error={form.errors.repository}>
          <Input
            {...form.field("repository")}
            mono
            placeholder="https://github.com/owner/name"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label={t("add.branch")} hint={t("add.branchHint")} error={form.errors.branch} optional>
          <Input {...form.field("branch")} mono placeholder="main" autoComplete="off" spellCheck={false} />
        </Field>
        {form.pending && <p className="text-sm text-muted">{t("add.working")}</p>}
      </div>
    </Dialog>
  );
}
