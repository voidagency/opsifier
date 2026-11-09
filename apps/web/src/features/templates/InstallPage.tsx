import type { TemplateInstall, TemplateInstallSecret } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ExternalLink, Eye, Rocket, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import {
  Button,
  ConfirmDialog,
  CopyButton,
  ErrorState,
  FormBanner,
  HealthSummary,
  Lamp,
  Markdown,
  MonoValue,
  overallState,
  PageHeader,
  Pictogram,
  RetentionSummary,
  Skeleton,
  Tooltip,
  toast,
  useDocumentTitle,
} from "../../ui";
import { servicePageLink } from "../databases/links";
import { projectsKey } from "../projects/api";
import { useActionFollower } from "../services/ActionFollower";
import {
  serviceCounts,
  servicePictogram,
  serviceState,
  serviceStateLabel,
  sortServices,
} from "../services/serviceState";
import { installQuery, installsKey, templatesApi } from "./api";
import { categoryPictograms, localized } from "./category";

function SecretRow({
  project,
  install,
  secret,
  language,
}: {
  project: string;
  install: string;
  secret: TemplateInstallSecret;
  language: string;
}) {
  const { t } = useTranslation(["templates", "common"]);
  const [value, setValue] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const reveal = async () => {
    setPending(true);
    setFailure(null);
    try {
      setValue((await templatesApi.reveal(project, install, secret.service, secret.name)).value);
    } catch (cause) {
      setFailure(errorMessage(cause, t));
    } finally {
      setPending(false);
    }
  };

  return (
    <li className="grid min-w-0 gap-1 border-b py-2.5 last:border-b-0">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 truncate text-sm">
          {secret.label === null ? secret.name : localized(secret.label, language)}
        </span>
        {value === null && (
          <Button
            size="sm"
            icon={<Eye aria-hidden="true" className="size-3.5" />}
            pending={pending}
            onClick={reveal}
          >
            {t("install.reveal")}
          </Button>
        )}
      </div>
      {value !== null && (
        <div className="flex min-w-0 items-center gap-1">
          <MonoValue value={value} truncate className="min-w-0 flex-1 text-xs" />
          <CopyButton value={value} label={t("install.copySecret")} />
        </div>
      )}
      {failure !== null && <FormBanner>{failure}</FormBanner>}
    </li>
  );
}

function ComponentRow({
  component,
  project,
}: {
  component: TemplateInstall["components"][number];
  project: string;
}) {
  const { t } = useTranslation(["templates", "services", "visual", "activity"]);
  const { service } = component;
  return (
    <li className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b py-3 last:border-b-0">
      <Lamp
        state={serviceState(service)}
        size="md"
        label={`${service.name}: ${serviceStateLabel(service, t)}`}
      />
      <Pictogram name={servicePictogram(service.type)} className="text-muted" />
      <div className="min-w-0">
        <Link
          {...servicePageLink(project, service.name, service.type)}
          className="font-mono text-sm font-medium hover:underline"
        >
          {service.name}
        </Link>
        <p className="truncate text-xs text-muted">{serviceStateLabel(service, t)}</p>
      </div>
      {component.url !== null && (
        <a
          href={component.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted hover:text-ink"
        >
          <span className="hidden max-w-[350px] truncate font-mono sm:inline" title={component.url}>
            {component.url}
          </span>
          <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
        </a>
      )}
    </li>
  );
}

/** What a template created: every part of it, how each is doing, and what to do next. */
export function InstallPage() {
  const { t, i18n } = useTranslation(["templates", "services", "visual", "common", "activity"]);
  const { project, install: installId } = useParams({ strict: false }) as {
    project: string;
    install: string;
  };
  const language = i18n.language;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const follow = useActionFollower();
  const [removing, setRemoving] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const { data, isPending, isError, error, refetch } = useQuery({
    ...installQuery(project, installId),
    refetchInterval: 3000,
  });
  useDocumentTitle(data?.templateName ?? "");

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: installsKey(project) }),
      queryClient.invalidateQueries({ queryKey: projectsKey }),
    ]);

  if (isPending) {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      </div>
    );
  }

  const components = data.components.map((component) => component.service);
  const counts = serviceCounts(components);
  const pending = components.some((service) => service.status !== "running");
  const busy = deploying || components.some((service) => service.activeAction !== null);
  const everyRunning = components.length > 0 && !pending;

  const deploy = async () => {
    setDeploying(true);
    try {
      const action = await templatesApi.deploy(project, data.id, { scope: everyRunning ? "all" : "pending" });
      follow(action.id, {
        success: () => {
          setDeploying(false);
          toast.success(t("install.deployed"));
        },
        failure: (ended) => {
          setDeploying(false);
          toast.error(t("install.deployFailed"), ended.error ?? undefined);
        },
      });
    } catch (cause) {
      setDeploying(false);
      toast.error(t("install.deployFailed"), errorMessage(cause, t));
    }
    await refresh();
  };

  const remove = async () => {
    await templatesApi.remove(project, data.id, data.templateName);
    await queryClient.invalidateQueries({ queryKey: projectsKey });
    toast({ title: t("install.removing", { name: data.templateName }) });
    await navigate({ to: "/projects/$project", params: { project } });
  };

  const state = overallState(counts) ?? "stopped";

  return (
    <>
      <PageHeader
        leading={<Lamp state={state} size="xl" decorative className="mt-1" />}
        title={
          <span className="inline-flex items-center gap-2.5">
            <span className="inline-flex text-muted">
              <Pictogram name={categoryPictograms[data.category]} size={24} />
            </span>
            {data.templateName}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <HealthSummary variant="row" counts={counts} label={t("install.parts")} />
            <span className="font-mono text-xs">v{data.templateVersion}</span>
            {data.custom && <span className="text-xs">{t("install.custom")}</span>}
          </span>
        }
        actions={
          <>
            <Button
              variant="primary"
              icon={<Rocket aria-hidden="true" className="size-4" />}
              pending={deploying}
              disabled={busy && !deploying}
              onClick={deploy}
            >
              {everyRunning
                ? t("install.redeploy")
                : pending && data.components.some((c) => c.service.status === "running")
                  ? t("install.resume")
                  : t("install.deploy")}
            </Button>
            <Tooltip content={t("install.remove")}>
              <Button size="icon" aria-label={t("install.remove")} onClick={() => setRemoving(true)}>
                <Trash2 aria-hidden="true" className="size-4" />
              </Button>
            </Tooltip>
          </>
        }
      />
      <div className="grid gap-6 px-4 py-6 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] md:gap-10 md:px-6 lg:px-8">
        <section className="grid content-start gap-3">
          <h2 className="eyebrow">{t("install.parts")}</h2>
          <ul className="border-y">
            {sortServicesKeepingRole(data.components).map((component) => (
              <ComponentRow key={component.service.name} component={component} project={project} />
            ))}
          </ul>
          <p className="text-xs text-muted">{t("install.deployHint")}</p>
        </section>
        <aside className="grid min-w-0 content-start gap-5">
          {data.instructions !== null && (
            <section className="grid gap-2">
              <h2 className="eyebrow">{t("install.nextSteps")}</h2>
              <Markdown text={localized(data.instructions, language)} className="grid gap-2 text-sm" />
            </section>
          )}
          {data.secrets.length > 0 && (
            <section className="grid gap-1">
              <h2 className="eyebrow">{t("install.secrets")}</h2>
              <ul className="border-y">
                {data.secrets.map((secret) => (
                  <SecretRow
                    key={`${secret.service}/${secret.name}`}
                    project={project}
                    install={data.id}
                    secret={secret}
                    language={language}
                  />
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t("install.removeTitle")}
        description={t("install.removeBody", { name: data.templateName })}
        confirmLabel={t("install.remove")}
        confirmText={data.templateName}
        onConfirm={remove}
      >
        <RetentionSummary removed={t("install.removeRemoved")} kept={t("install.removeKept")} />
      </ConfirmDialog>
    </>
  );
}

/** Problems first, as in every list, keeping each row's kind beside it. */
function sortServicesKeepingRole(components: TemplateInstall["components"]) {
  const order = sortServices(components.map((component) => component.service)).map((service) => service.name);
  return [...components].sort((a, b) => order.indexOf(a.service.name) - order.indexOf(b.service.name));
}
