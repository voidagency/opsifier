import {
  type BackupConfigEntry,
  backupSchedulePresets,
  type DatabaseBackupScope,
  DEFAULT_BACKUP_CRON,
  databaseBackupScopes,
  presetOfCron,
  saveBackupConfigRequest,
} from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { schemaErrors, useForm } from "../../lib/forms";
import { Button, Dialog, Field, FormBanner, Input, Select, Switch, toast } from "../../ui";
import { backupsApi, databasesQuery, destinationsQuery } from "./api";

export interface ConfigDialogProps {
  project: string;
  service: string;
  kind: "database" | "volume";
  defaultDatabase: string | null;
  volumes: readonly string[];
  /** The configuration being edited, or undefined to create one. */
  editing?: BackupConfigEntry;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}

interface Values extends Record<string, unknown> {
  enabled: boolean;
  schedule: string;
  retention: string;
  scope: DatabaseBackupScope;
  databaseName: string;
  volumeName: string;
  storageProviderId: string;
  path: string;
}

const CUSTOM = "custom";

function initialValues(props: ConfigDialogProps): Values {
  const { editing, defaultDatabase, volumes, project, service } = props;
  return {
    enabled: editing?.enabled ?? true,
    schedule: editing?.schedule ?? DEFAULT_BACKUP_CRON,
    retention:
      editing?.retention === null || editing?.retention === undefined ? "" : String(editing.retention),
    scope: editing === undefined || editing.scope === "volume" ? "database" : editing.scope,
    databaseName: editing?.databaseName ?? defaultDatabase ?? "",
    volumeName: editing?.volumeName ?? volumes[0] ?? "",
    storageProviderId: editing?.storageProviderId ?? "",
    path: editing?.path ?? `${project}/${service}`,
  };
}

function bodyOf(kind: "database" | "volume", values: Values) {
  const shared = {
    enabled: values.enabled,
    schedule: values.schedule,
    retention: values.retention === "" ? null : values.retention,
    storageProviderId: values.storageProviderId,
    path: values.path,
  };
  return kind === "database"
    ? {
        kind,
        ...shared,
        scope: values.scope,
        ...(values.scope === "database" ? { databaseName: values.databaseName } : {}),
      }
    : { kind, ...shared, volumeName: values.volumeName };
}

/** One dialog for databases and volumes: what is backed up, where it goes, and when. */
export function ConfigDialog(props: ConfigDialogProps) {
  const { project, service, kind, editing, volumes, onClose, onSaved } = props;
  const { t } = useTranslation(["backups", "common"]);
  const { data: destinations } = useQuery(destinationsQuery(project, service));
  const { data: databases } = useQuery({
    ...databasesQuery(project, service),
    enabled: kind === "database",
  });
  const listId = useId();
  const [customPreset, setCustomPreset] = useState(false);

  const form = useForm<Values>({
    t,
    initialValues: initialValues(props),
    validate: (values) =>
      schemaErrors<keyof Values & string>(saveBackupConfigRequest, bodyOf(kind, values), {
        schedule: t("errors.schedule"),
        retention: t("errors.retention"),
        databaseName: t("errors.databaseName"),
        volumeName: t("errors.volumeName"),
        scope: t("errors.scope"),
        storageProviderId: t("errors.provider"),
        path: t("errors.path"),
      }),
    onSubmit: async (values) => {
      if (editing === undefined) {
        await backupsApi.createConfig(project, service, bodyOf(kind, values));
      } else {
        await backupsApi.updateConfig(project, service, editing.id, bodyOf(kind, values));
      }
      await onSaved();
      toast.success(editing === undefined ? t("config.created") : t("config.updated"));
      onClose();
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: only once, when the list arrives
  useEffect(() => {
    if (form.values.storageProviderId === "" && destinations?.options[0] !== undefined) {
      form.set("storageProviderId", destinations.options[0].id);
    }
  }, [destinations]);

  const preset = customPreset ? CUSTOM : (presetOfCron(form.values.schedule) ?? CUSTOM);
  const presetOptions = [
    ...backupSchedulePresets.map((entry) => ({
      value: entry.key,
      label: t(`schedule.presets.${entry.key}`),
    })),
    { value: CUSTOM, label: t("schedule.presets.custom") },
  ];

  const onPreset = (value: string) => {
    if (value === CUSTOM) {
      setCustomPreset(true);
      return;
    }
    setCustomPreset(false);
    const chosen = backupSchedulePresets.find((entry) => entry.key === value);
    if (chosen !== undefined) {
      form.set("schedule", chosen.cron);
    }
  };

  const onCron = (value: string) => {
    setCustomPreset(false);
    form.set("schedule", value);
  };

  const provider = destinations?.options.find((option) => option.id === form.values.storageProviderId);

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="md"
      title={editing === undefined ? t(`config.create.${kind}`) : t(`config.edit.${kind}`)}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={form.pending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("config.save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Switch
          label={t("config.enabled")}
          hint={t("config.enabledHint")}
          checked={form.values.enabled}
          onCheckedChange={(checked) => form.set("enabled", checked)}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("config.schedule")} hint={t("config.scheduleHint")}>
            <Select value={preset} onValueChange={onPreset} options={presetOptions} />
          </Field>
          <Field label={t("config.cron")} hint={t("config.cronHint")} error={form.errors.schedule}>
            <Input
              mono
              autoComplete="off"
              spellCheck={false}
              value={form.values.schedule}
              onChange={(event) => onCron(event.currentTarget.value)}
            />
          </Field>
        </div>
        {kind === "database" && (
          <Field
            label={t("config.scope")}
            hint={t(`config.scopeHint.${form.values.scope}`)}
            error={form.errors.scope}
          >
            <Select
              value={form.values.scope}
              onValueChange={(value) => form.set("scope", value as DatabaseBackupScope)}
              options={databaseBackupScopes.map((scope) => ({ value: scope, label: t(`scope.${scope}`) }))}
            />
          </Field>
        )}
        {kind === "database" ? (
          form.values.scope === "database" && (
            <Field
              label={t("config.databaseName")}
              error={form.errors.databaseName}
              hint={t("config.databaseNameHint")}
            >
              <Input
                {...form.field("databaseName")}
                mono
                autoComplete="off"
                spellCheck={false}
                list={listId}
                placeholder={t("config.databasePlaceholder")}
              />
              <datalist id={listId}>
                {databases?.databases.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </Field>
          )
        ) : (
          <Field label={t("config.volume")} error={form.errors.volumeName} hint={t("config.volumeHint")}>
            <Select
              value={form.values.volumeName}
              onValueChange={(value) => form.set("volumeName", value)}
              options={volumes.map((name) => ({ value: name, label: name }))}
              placeholder={t("config.volumePlaceholder")}
            />
          </Field>
        )}
        <Field
          label={t("config.provider")}
          hint={provider?.offHost === false ? t("config.providerLocalHint") : undefined}
          error={form.errors.storageProviderId}
        >
          <Select
            value={form.values.storageProviderId}
            onValueChange={(value) => form.set("storageProviderId", value)}
            options={(destinations?.options ?? []).map((option) => ({
              value: option.id,
              label: option.name,
            }))}
            placeholder={t("config.providerPlaceholder")}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("config.path")} hint={t("config.pathHint")} error={form.errors.path}>
            <Input {...form.field("path")} mono autoComplete="off" spellCheck={false} />
          </Field>
          <Field
            label={t("config.retention")}
            hint={t("config.retentionHint")}
            error={form.errors.retention}
            optional
          >
            <Input
              {...form.field("retention")}
              mono
              inputMode="numeric"
              autoComplete="off"
              placeholder={t("config.retentionPlaceholder")}
            />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
