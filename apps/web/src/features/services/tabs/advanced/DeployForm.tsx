import { type DeploySettings, deploySettings, parseSysctlText, splitList } from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { schemaErrors, useForm } from "../../../../lib/forms";
import { Button, Field, FormBanner, Input, Switch, toast } from "../../../../ui";
import { advancedApi, advancedQuery } from "./api";

interface FormValues extends Record<string, unknown> {
  replicas: string;
  zeroDowntime: boolean;
  tiniInit: boolean;
  command: string;
  capAdd: string;
  capDrop: string;
  sysctls: string;
  groups: string;
}

function toFormValues(settings: DeploySettings): FormValues {
  return {
    replicas: String(settings.replicas),
    zeroDowntime: settings.zeroDowntime,
    tiniInit: settings.tiniInit,
    command: settings.command ?? "",
    capAdd: settings.capAdd.join(", "),
    capDrop: settings.capDrop.join(", "),
    sysctls: Object.entries(settings.sysctls)
      .map(([key, value]) => `${key}=${value}`)
      .join(", "),
    groups: settings.groups.join(", "),
  };
}

const capabilities = (text: string) => splitList(text).map((name) => name.toUpperCase().replace(/^CAP_/, ""));

function toSettings(values: FormValues): DeploySettings {
  const command = values.command.trim();
  return {
    replicas: values.replicas.trim() === "" ? Number.NaN : Number(values.replicas),
    zeroDowntime: values.zeroDowntime,
    tiniInit: values.tiniInit,
    command: command === "" ? null : command,
    capAdd: capabilities(values.capAdd),
    capDrop: capabilities(values.capDrop),
    sysctls: parseSysctlText(values.sysctls),
    groups: splitList(values.groups),
  };
}

type Name = "replicas" | "command" | "capAdd" | "capDrop" | "sysctls" | "groups";

export function DeployForm({
  project,
  service,
  settings,
  stopped,
  publishesPorts,
}: {
  project: string;
  service: string;
  settings: DeploySettings;
  stopped: boolean;
  publishesPorts: boolean;
}) {
  const { t } = useTranslation(["service-advanced", "common"]);
  const queryClient = useQueryClient();
  const form = useForm<FormValues>({
    t,
    initialValues: toFormValues(settings),
    validate: (values) => {
      const candidate = toSettings(values);
      const problems = schemaErrors<Name>(deploySettings, candidate, {
        replicas: stopped ? t("errors.replicasStopped") : t("errors.replicas"),
        command: t("errors.command"),
        capAdd: t("errors.capabilities"),
        capDrop: t("errors.capabilities"),
        sysctls: t("errors.sysctls"),
        groups: t("errors.groups"),
      });
      if (!stopped && candidate.replicas === 0) {
        problems.replicas = t("errors.replicas");
      }
      return problems;
    },
    onSubmit: async (values) => {
      await advancedApi.saveDeploy(project, service, toSettings(values));
      await queryClient.invalidateQueries({ queryKey: advancedQuery(project, service).queryKey });
      toast.success(t("deploy.saved"), t("savedHint"));
    },
  });

  return (
    <form onSubmit={form.handleSubmit} noValidate className="grid gap-4">
      {form.banner && <FormBanner>{form.banner}</FormBanner>}
      <Field
        label={t("deploy.replicas")}
        hint={stopped ? t("deploy.replicasStoppedHint") : undefined}
        error={form.errors.replicas}
        className="max-w-[360px]"
      >
        <Input {...form.field("replicas")} mono type="number" className="max-w-[160px]" />
      </Field>
      <Switch
        label={t("deploy.zeroDowntime")}
        hint={publishesPorts ? t("deploy.zeroDowntimeWithPorts") : t("deploy.zeroDowntimeHint")}
        checked={form.values.zeroDowntime}
        onCheckedChange={(checked) => form.set("zeroDowntime", checked)}
      />
      <Switch
        label={t("deploy.tiniInit")}
        hint={t("deploy.tiniInitHint")}
        checked={form.values.tiniInit}
        onCheckedChange={(checked) => form.set("tiniInit", checked)}
      />
      <Field label={t("deploy.command")} hint={t("deploy.commandHint")} error={form.errors.command} optional>
        <Input {...form.field("command")} mono autoComplete="off" spellCheck={false} />
      </Field>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t("deploy.capAdd")} error={form.errors.capAdd} optional>
          <Input
            {...form.field("capAdd")}
            mono
            autoComplete="off"
            spellCheck={false}
            placeholder="NET_ADMIN, SYS_MODULE"
          />
        </Field>
        <Field label={t("deploy.capDrop")} error={form.errors.capDrop} optional>
          <Input {...form.field("capDrop")} mono autoComplete="off" spellCheck={false} placeholder="MKNOD" />
        </Field>
      </div>
      <Field label={t("deploy.sysctls")} hint={t("deploy.sysctlsHint")} error={form.errors.sysctls} optional>
        <Input
          {...form.field("sysctls")}
          mono
          autoComplete="off"
          spellCheck={false}
          placeholder="net.core.somaxconn=1024"
        />
      </Field>
      <Field label={t("deploy.groups")} hint={t("deploy.groupsHint")} error={form.errors.groups} optional>
        <Input {...form.field("groups")} mono autoComplete="off" spellCheck={false} placeholder="999" />
      </Field>
      <div>
        <Button type="submit" variant="primary" pending={form.pending}>
          {t("deploy.submit")}
        </Button>
      </div>
    </form>
  );
}
