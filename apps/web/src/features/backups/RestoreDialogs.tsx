import {
  type BackupEntry,
  type DatabaseBackupScope,
  databaseBackupScopes,
  restoreFromPathRequest,
} from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { schemaErrors, useForm } from "../../lib/forms";
import { Button, ConfirmDialog, Dialog, Field, FormBanner, Input, MonoValue, Select, toast } from "../../ui";
import { useActionFollower } from "../services/ActionFollower";
import { backupsApi, databasesQuery, destinationsQuery } from "./api";

export interface RestoreBackupDialogProps {
  project: string;
  service: string;
  backup: BackupEntry;
  onClose: () => void;
  onStarted: () => Promise<unknown>;
}

/** Restoring one recorded backup. The name to type is exactly what is about to be replaced. */
export function RestoreBackupDialog({
  project,
  service,
  backup,
  onClose,
  onStarted,
}: RestoreBackupDialogProps) {
  const { t } = useTranslation(["backups", "common"]);
  const follow = useActionFollower();
  // A whole server or its accounts have no database to name: what is typed is the service itself.
  const target =
    backup.scope === "database"
      ? (backup.databaseName ?? "")
      : backup.scope === "volume"
        ? (backup.volumeName ?? "")
        : service;

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t(`restore.title.${backup.scope}`)}
      description={t(`restore.description.${backup.scope}`, { target })}
      confirmLabel={t("restore.confirm")}
      confirmText={target}
      onConfirm={async () => {
        const action = await backupsApi.restore(project, service, backup.id, { confirm: target });
        follow(action.id, {
          success: () => toast.success(t("restore.done")),
          failure: (ended) => toast.error(t("restore.failed"), ended.error ?? undefined),
        });
        toast({ title: t("restore.started") });
        await onStarted();
      }}
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="eyebrow">{t("restore.file")}</dt>
        <dd className="min-w-0 break-all">
          <MonoValue value={backup.path} />
        </dd>
        <dt className="eyebrow">{t("restore.destination")}</dt>
        <dd>{backup.storageProviderName}</dd>
        {backup.sha256 !== null && (
          <>
            <dt className="eyebrow">{t("restore.checksum")}</dt>
            <dd className="min-w-0 break-all">
              <MonoValue value={backup.sha256} />
            </dd>
          </>
        )}
      </dl>
    </ConfirmDialog>
  );
}

export interface RestoreFromPathDialogProps {
  project: string;
  service: string;
  scope: "database" | "volume";
  defaultDatabase: string | null;
  onClose: () => void;
  onStarted: () => Promise<unknown>;
}

interface PathValues extends Record<string, unknown> {
  storageProviderId: string;
  path: string;
  scope: DatabaseBackupScope;
  databaseName: string;
  confirm: string;
}

/** A whole server or its accounts are confirmed by the service's name: they name no database. */
function pathTarget(values: PathValues, scope: "database" | "volume", service: string): string {
  return scope === "database" && values.scope !== "database" ? service : values.databaseName;
}

function pathBody(values: PathValues, scope: "database" | "volume") {
  const { storageProviderId, path, confirm, databaseName } = values;
  if (scope === "volume") {
    return { storageProviderId, path, databaseName, confirm };
  }
  return values.scope === "database"
    ? { storageProviderId, path, scope: values.scope, databaseName, confirm }
    : { storageProviderId, path, scope: values.scope, confirm };
}

/** Restoring a file by its path, for a backup this panel has no record of. */
export function RestoreFromPathDialog({
  project,
  service,
  scope,
  defaultDatabase,
  onClose,
  onStarted,
}: RestoreFromPathDialogProps) {
  const { t } = useTranslation(["backups", "common"]);
  const follow = useActionFollower();
  const listId = useId();
  const { data: destinations } = useQuery(destinationsQuery(project, service));
  const { data: databases } = useQuery({
    ...databasesQuery(project, service),
    enabled: scope === "database",
  });
  const [started, setStarted] = useState(false);

  const form = useForm<PathValues>({
    t,
    initialValues: {
      storageProviderId: "",
      path: "",
      scope: "database",
      databaseName: defaultDatabase ?? "",
      confirm: "",
    },
    validate: (values) => {
      const errors = schemaErrors<keyof PathValues & string>(
        restoreFromPathRequest,
        pathBody(values, scope),
        {
          storageProviderId: t("errors.provider"),
          path: t("errors.restorePath"),
          scope: t("errors.scope"),
          databaseName: t("errors.databaseName"),
          confirm: t("restore.confirmRequired"),
        },
      );
      if (values.scope === "database" && values.databaseName === "") {
        errors.databaseName = t("errors.databaseName");
      }
      if (values.confirm !== pathTarget(values, scope, service)) {
        errors.confirm = t("restore.confirmRequired");
      }
      return errors;
    },
    onSubmit: async (values) => {
      const action = await backupsApi.restoreFromPath(project, service, pathBody(values, scope));
      follow(action.id, {
        success: () => toast.success(t("restore.done")),
        failure: (ended) => toast.error(t("restore.failed"), ended.error ?? undefined),
      });
      setStarted(true);
      toast({ title: t("restore.started") });
      await onStarted();
      onClose();
    },
  });

  const target = pathTarget(form.values, scope, service);
  const namesADatabase = scope === "volume" || form.values.scope === "database";

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !form.pending && !started && onClose()}
      size="md"
      title={t("restore.fromPath.title")}
      description={t(`restore.fromPath.description.${scope}`)}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={form.pending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="danger" pending={form.pending}>
            {t("restore.confirm")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field
          label={t("config.provider")}
          error={form.errors.storageProviderId}
          hint={t("config.providerHint")}
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
        <Field
          label={t("restore.fromPath.path")}
          hint={t("restore.fromPath.pathHint")}
          error={form.errors.path}
        >
          <Input
            {...form.field("path")}
            mono
            autoComplete="off"
            spellCheck={false}
            placeholder={`${project}/${service}/2026-01-01T02:00:00.000Z.sql.gz`}
          />
        </Field>
        {scope === "database" && (
          <Field
            label={t("restore.fromPath.scope")}
            hint={t("restore.fromPath.scopeHint")}
            error={form.errors.scope}
          >
            <Select
              value={form.values.scope}
              onValueChange={(value) => form.set("scope", value as DatabaseBackupScope)}
              options={databaseBackupScopes.map((entry) => ({ value: entry, label: t(`scope.${entry}`) }))}
            />
          </Field>
        )}
        {namesADatabase && (
          <Field
            label={scope === "database" ? t("config.databaseName") : t("config.volume")}
            error={form.errors.databaseName}
            hint={t("restore.targetHint")}
          >
            <Input
              {...form.field("databaseName")}
              mono
              autoComplete="off"
              spellCheck={false}
              list={listId}
              placeholder={scope === "database" ? t("config.databasePlaceholder") : undefined}
            />
            <datalist id={listId}>
              {databases?.databases.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </Field>
        )}
        <Field
          label={
            <>
              {t("common:confirm.typeToConfirm")} <MonoValue value={target} className="font-medium" />
            </>
          }
          error={form.errors.confirm}
          hint={t("restore.confirmHint")}
        >
          <Input
            {...form.field("confirm")}
            mono
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
      </div>
    </Dialog>
  );
}
