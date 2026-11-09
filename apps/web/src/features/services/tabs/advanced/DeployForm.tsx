import {
  type DeploySettings,
  deploySettings,
  parseSysctlText,
  STOP_SIGNALS,
  splitList,
} from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { schemaErrors, useForm } from "../../../../lib/forms";
import { Button, Field, FormBanner, Input, Select, Switch, toast } from "../../../../ui";
import { useCurrentUser } from "../../../auth/session";
import { advancedApi, advancedQuery } from "./api";

interface FormValues extends Record<string, unknown> {
  replicas: string;
  zeroDowntime: boolean;
  tiniInit: boolean;
  command: string;
  stopSignal: string;
  stopGraceSeconds: string;
  capAdd: string;
  capDrop: string;
  sysctls: string;
  groups: string;
}

/** A Select option can't be empty, so "whatever the image declares" gets a name of its own. */
const IMAGE_STOP_SIGNAL = "image";

function toFormValues(settings: DeploySettings): FormValues {
  return {
    replicas: String(settings.replicas),
    zeroDowntime: settings.zeroDowntime,
    tiniInit: settings.tiniInit,
    command: settings.command ?? "",
    stopSignal: settings.stopSignal ?? IMAGE_STOP_SIGNAL,
    stopGraceSeconds: String(settings.stopGraceSeconds),
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
    stopSignal:
      values.stopSignal === IMAGE_STOP_SIGNAL ? null : (values.stopSignal as DeploySettings["stopSignal"]),
    stopGraceSeconds: values.stopGraceSeconds.trim() === "" ? Number.NaN : Number(values.stopGraceSeconds),
    capAdd: capabilities(values.capAdd),
    capDrop: capabilities(values.capDrop),
    sysctls: parseSysctlText(values.sysctls),
    groups: splitList(values.groups),
  };
}

type Name = "replicas" | "command" | "stopGraceSeconds" | "capAdd" | "capDrop" | "sysctls" | "groups";

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
  const isAdmin = useCurrentUser()?.role === "admin";
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
        stopGraceSeconds: t("errors.stopGraceSeconds"),
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
        className="max-w-[450px]"
      >
        <Input {...form.field("replicas")} mono type="number" className="max-w-[200px]" />
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
        <Field label={t("deploy.stopSignal")} hint={t("deploy.stopSignalHint")}>
          <Select
            value={form.values.stopSignal}
            onValueChange={(value) => form.set("stopSignal", value)}
            options={[
              { value: IMAGE_STOP_SIGNAL, label: t("deploy.stopSignalImage") },
              ...STOP_SIGNALS.map((signal) => ({ value: signal, label: signal })),
            ]}
          />
        </Field>
        <Field
          label={t("deploy.stopGraceSeconds")}
          hint={t("deploy.stopGraceSecondsHint")}
          error={form.errors.stopGraceSeconds}
        >
          <Input {...form.field("stopGraceSeconds")} mono type="number" />
        </Field>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label={t("deploy.capAdd")}
          hint={isAdmin ? t("deploy.capAddHint") : t("deploy.adminOnly")}
          error={form.errors.capAdd}
          optional
        >
          <Input
            {...form.field("capAdd")}
            mono
            autoComplete="off"
            spellCheck={false}
            placeholder="NET_ADMIN, SYS_MODULE"
            disabled={!isAdmin}
          />
        </Field>
        <Field
          label={t("deploy.capDrop")}
          error={form.errors.capDrop}
          optional
          hint={t("deploy.capDropHint")}
        >
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
