import type { StudioCheck, StudioSettings } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, useForm } from "../../lib/forms";
import { Button, ErrorState, Field, FormBanner, Input, Select, Skeleton, Switch, toast } from "../../ui";
import { projectsQuery } from "../projects/api";
import { studioApi, studioKey, studioSettingsQuery } from "./api";

const DEFAULT_URL = "http://127.0.0.1:18000";
const DEFAULT_KEY_FILE = "/home/openhands/.openhands/agent-canvas/api-key.txt";

/** Settings, Server, Studio: whether the Studio is on, and which service runs its agent server. */
export function StudioSettingsPage() {
  const { t } = useTranslation(["studio", "common"]);
  const { data, isPending, isError, error, refetch } = useQuery(studioSettingsQuery);

  if (isPending) {
    return <Skeleton className="m-6 h-40" />;
  }
  if (isError) {
    return <ErrorState className="m-6" message={errorMessage(error, t)} onRetry={() => refetch()} />;
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 px-4 py-6 md:px-6 lg:px-8">
      <div>
        <h2 className="text-md font-medium">{t("settings.title")}</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">{t("settings.description")}</p>
      </div>
      <SettingsForm settings={data} />
    </div>
  );
}

function SettingsForm({ settings }: { settings: StudioSettings }) {
  const { t } = useTranslation(["studio", "common"]);
  const queryClient = useQueryClient();
  const projects = useQuery(projectsQuery);
  const [check, setCheck] = useState<StudioCheck | null>(null);
  const options = (projects.data?.projects ?? []).flatMap((project) =>
    project.services.map((service) => ({
      value: `${project.name}/${service.name}`,
      label: `${project.name} / ${service.name}`,
    })),
  );
  const { agent } = settings;
  const form = useForm({
    t,
    initialValues: {
      enabled: settings.enabled,
      previewSignIn: settings.previewSignIn,
      service: agent === null ? "" : `${agent.project}/${agent.service}`,
      url: agent?.url ?? DEFAULT_URL,
      keyFile: agent === null ? DEFAULT_KEY_FILE : (agent.keyFile ?? ""),
      projectsDir: agent?.projectsDir ?? "",
    },
    validate: (values) => ({
      ...(values.enabled && values.service === "" ? { service: t("settings.serviceRequired") } : {}),
    }),
    onSubmit: async (values) => {
      const [project = "", service = ""] = values.service.split("/");
      await studioApi.saveSettings({
        enabled: values.enabled,
        previewSignIn: values.previewSignIn,
        agent:
          values.service === ""
            ? null
            : {
                project,
                service,
                url: values.url.trim(),
                keyFile: values.keyFile.trim() === "" ? null : values.keyFile.trim(),
                projectsDir: values.projectsDir.trim() === "" ? null : values.projectsDir.trim(),
              },
      });
      await queryClient.invalidateQueries({ queryKey: studioKey });
      setCheck(null);
      toast.success(t("settings.saved"));
    },
  });

  const runCheck = async () => {
    try {
      setCheck(await studioApi.check());
    } catch (reason) {
      toast.error(errorMessage(reason, t));
    }
  };

  return (
    <form className="grid max-w-[620px] gap-5" onSubmit={form.handleSubmit}>
      {form.banner && <FormBanner>{form.banner}</FormBanner>}
      <section className="border-y py-3">
        <Switch
          label={t("settings.enabled")}
          hint={t("settings.enabledHint")}
          checked={form.values.enabled}
          onCheckedChange={(enabled) => form.set("enabled", enabled)}
        />
      </section>
      <section className="border-b pb-3">
        <Switch
          label={t("settings.previewSignIn")}
          hint={t("settings.previewSignInHint")}
          checked={form.values.previewSignIn}
          onCheckedChange={(previewSignIn) => form.set("previewSignIn", previewSignIn)}
        />
      </section>
      <Field label={t("settings.service")} hint={t("settings.serviceHint")} error={form.errors.service}>
        <Select
          value={form.values.service === "" ? undefined : form.values.service}
          onValueChange={(value) => form.set("service", value)}
          options={options}
          placeholder={t("settings.servicePlaceholder")}
        />
      </Field>
      <Field label={t("settings.url")} hint={t("settings.urlHint")} error={form.errors.url}>
        <Input {...form.field("url")} mono autoComplete="off" spellCheck={false} />
      </Field>
      <Field
        label={t("settings.keyFile")}
        hint={t("settings.keyFileHint")}
        error={form.errors.keyFile}
        optional
      >
        <Input {...form.field("keyFile")} mono autoComplete="off" spellCheck={false} />
      </Field>
      <Field
        label={t("settings.projectsDir")}
        hint={t("settings.projectsDirHint")}
        error={form.errors.projectsDir}
        optional
      >
        <Input
          {...form.field("projectsDir")}
          mono
          autoComplete="off"
          spellCheck={false}
          placeholder="/projects"
        />
      </Field>
      {check !== null && (
        <FormBanner tone={check.reachable ? "success" : "error"}>
          {check.reachable
            ? t("settings.checkOk", { version: check.version ?? "?" })
            : t("settings.checkFailed", { message: check.message ?? "" })}
        </FormBanner>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" pending={form.pending}>
          {t("settings.save")}
        </Button>
        <Button onClick={runCheck} disabled={settings.agent === null}>
          {t("settings.check")}
        </Button>
      </div>
    </form>
  );
}
