import type { ServiceStatus, StudioApp } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, useForm } from "../../lib/forms";
import {
  Button,
  buttonClass,
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
  toast,
} from "../../ui";
import { useCurrentUser } from "../auth/session";
import { projectsQuery } from "../projects/api";
import { studioApi, studioKey, studioOverviewQuery } from "./api";

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
  const { data, isPending, isError, error, refetch } = useQuery({ ...studioOverviewQuery, enabled: admin });
  const [linking, setLinking] = useState(false);

  const body = () => {
    if (!admin) {
      return (
        <EmptyState
          illustration="not-found"
          title={t("restricted.title")}
          description={t("restricted.description")}
        />
      );
    }
    if (isPending) {
      return <Skeleton className="h-32" />;
    }
    if (isError) {
      return <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />;
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
          description={t("list.emptyDescription")}
          action={
            <Button variant="primary" onClick={() => setLinking(true)}>
              {t("link.action")}
            </Button>
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
            <Button icon={<Plus aria-hidden="true" className="size-4" />} onClick={() => setLinking(true)}>
              {t("link.action")}
            </Button>
          ) : undefined
        }
      />
      {body()}
      {linking && <LinkDialog onClose={() => setLinking(false)} />}
    </div>
  );
}

function AppRow({ app }: { app: StudioApp }) {
  const { t } = useTranslation(["studio", "common"]);
  const last = app.lastConversation;
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b py-3 last:border-b-0">
      <Lamp state={lampOf[app.previewStatus]} size="xs" label={t(`preview.status.${app.previewStatus}`)} />
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate font-medium">{app.service}</span>
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
      <Link
        to="/studio/$project/$service"
        params={{ project: app.project, service: app.service }}
        search={{}}
        className={buttonClass("secondary", "sm")}
        aria-label={t("list.openNamed", { name: app.service })}
      >
        {t("list.open")}
      </Link>
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
