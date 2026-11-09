import {
  createStorageProviderRequest,
  isOAuthKind,
  isS3Kind,
  requiredPermissions,
  type S3ProviderKind,
  type StorageProviderEntry,
  type StorageProviderKind,
  s3KindInfo,
  updateStorageProviderRequest,
} from "@opsifier/contract";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isApiError } from "../../lib/api";
import { schemaErrors, useForm } from "../../lib/forms";
import { Button, Dialog, Field, FormBanner, Input, MonoValue, PasswordInput, Switch, toast } from "../../ui";
import { storageProvidersApi } from "./api";

export interface ProviderDialogProps {
  kind: StorageProviderKind;
  editing?: StorageProviderEntry;
  /** Where Dropbox and Google Drive send the browser back to. */
  redirectUrl: string;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}

interface Values extends Record<string, unknown> {
  name: string;
  path: string;
  host: string;
  port: string;
  username: string;
  password: string;
  rootPath: string;
  tls: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
  endpoint: string;
  storageClass: string;
  prefix: string;
  clientId: string;
  clientSecret: string;
  trustNewHostKey: boolean;
}

const FIELD_LABELS: ReadonlyArray<keyof Values & string> = [
  "name",
  "path",
  "host",
  "port",
  "username",
  "password",
  "rootPath",
  "accessKeyId",
  "secretAccessKey",
  "bucket",
  "region",
  "endpoint",
  "storageClass",
  "prefix",
  "clientId",
  "clientSecret",
];

function initialValues(editing: StorageProviderEntry | undefined): Values {
  const config = editing?.config;
  return {
    name: editing?.name ?? "",
    path: config?.kind === "local" ? config.path : "",
    host: config?.kind === "sftp" || config?.kind === "ftp" ? config.host : "",
    port: config?.kind === "sftp" || config?.kind === "ftp" ? String(config.port) : "",
    username: config?.kind === "sftp" || config?.kind === "ftp" ? config.username : "",
    password: "",
    rootPath: config?.kind === "sftp" || config?.kind === "ftp" ? config.rootPath : "",
    tls: config?.kind === "ftp" ? config.tls : false,
    accessKeyId: config !== undefined && "accessKeyId" in config ? config.accessKeyId : "",
    secretAccessKey: "",
    bucket: config !== undefined && "bucket" in config ? config.bucket : "",
    region: config !== undefined && "region" in config ? config.region : "",
    endpoint: config !== undefined && "endpoint" in config ? (config.endpoint ?? "") : "",
    storageClass: config !== undefined && "storageClass" in config ? (config.storageClass ?? "") : "",
    prefix: config !== undefined && "prefix" in config ? config.prefix : "",
    clientId: config !== undefined && "clientId" in config ? config.clientId : "",
    clientSecret: "",
    trustNewHostKey: false,
  };
}

/** Turns the form's values into the request for this kind of destination, and nothing more. */
function bodyFor(kind: StorageProviderKind, values: Values, editing: boolean) {
  const common = { kind, name: values.name };
  if (kind === "local") {
    return { ...common, path: values.path };
  }
  if (kind === "sftp" || kind === "ftp") {
    const server = {
      ...common,
      host: values.host,
      port: values.port,
      username: values.username,
      rootPath: values.rootPath,
    };
    const base = editing
      ? { ...server, password: values.password || undefined }
      : { ...server, password: values.password };
    return kind === "sftp"
      ? editing
        ? { ...base, trustNewHostKey: values.trustNewHostKey }
        : base
      : { ...base, tls: values.tls };
  }
  if (isOAuthKind(kind)) {
    return editing ? common : { ...common, clientId: values.clientId, clientSecret: values.clientSecret };
  }
  const s3 = {
    ...common,
    accessKeyId: values.accessKeyId,
    bucket: values.bucket,
    region: values.region,
    endpoint: values.endpoint,
    storageClass: values.storageClass,
    prefix: values.prefix,
  };
  return editing
    ? { ...s3, secretAccessKey: values.secretAccessKey || undefined }
    : { ...s3, secretAccessKey: values.secretAccessKey };
}

export function ProviderDialog({ kind, editing, redirectUrl, onClose, onSaved }: ProviderDialogProps) {
  const { t } = useTranslation(["storage-providers", "common"]);
  const [hostKeyChanged, setHostKeyChanged] = useState(false);
  const isEdit = editing !== undefined;

  const form = useForm<Values>({
    t,
    initialValues: initialValues(editing),
    validate: (values) =>
      schemaErrors<keyof Values & string>(
        isEdit ? updateStorageProviderRequest : createStorageProviderRequest,
        bodyFor(kind, values, isEdit),
        Object.fromEntries(FIELD_LABELS.map((field) => [field, t(`errors.${field}`)])),
      ),
    onSubmit: async (values) => {
      const body = bodyFor(kind, values, isEdit);
      try {
        if (editing !== undefined) {
          await storageProvidersApi.update(
            editing.id,
            body as Parameters<typeof storageProvidersApi.update>[1],
          );
        } else {
          const created = await storageProvidersApi.create(
            body as Parameters<typeof storageProvidersApi.create>[0],
          );
          if (isOAuthKind(kind)) {
            const { authorizationUrl } = await storageProvidersApi.connect(created.id);
            window.location.assign(authorizationUrl);
            return;
          }
        }
      } catch (error) {
        if (isApiError(error) && error.code === "host_key_changed") {
          setHostKeyChanged(true);
        }
        throw error;
      }
      await onSaved();
      toast.success(isEdit ? t("updated") : t("created"));
      onClose();
    },
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh dialog starts from its own values
  useEffect(() => {
    form.reset(initialValues(editing));
  }, [editing, kind]);

  const s3Info = isS3Kind(kind) ? s3KindInfo[kind as S3ProviderKind] : null;
  const isServer = kind === "sftp" || kind === "ftp";

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !form.pending && onClose()}
      size="md"
      title={
        isEdit
          ? t("dialog.editTitle", { kind: t(`kinds.${kind}`) })
          : t("dialog.createTitle", { kind: t(`kinds.${kind}`) })
      }
      description={t(
        `dialog.description.${isOAuthKind(kind) ? "oauth" : kind === "local" ? "local" : isServer ? "server" : "s3"}`,
      )}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={form.pending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {isEdit ? t("dialog.save") : isOAuthKind(kind) ? t("dialog.saveAndConnect") : t("dialog.create")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("fields.name")} error={form.errors.name} hint={t("fields.nameHint")}>
          <Input
            {...form.field("name")}
            autoComplete="off"
            autoFocus
            placeholder={isS3Kind(kind) ? t(`kinds.${kind}`) : t(`placeholders.${kind}`)}
          />
        </Field>

        {kind === "local" && (
          <Field label={t("fields.path")} hint={t("hints.path")} error={form.errors.path}>
            <Input
              {...form.field("path")}
              mono
              autoComplete="off"
              spellCheck={false}
              placeholder="/srv/backups"
            />
          </Field>
        )}

        {isServer && (
          <>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
              <Field label={t("fields.host")} error={form.errors.host} hint={t("fields.hostHint")}>
                <Input
                  {...form.field("host")}
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="backups.example.com"
                />
              </Field>
              <Field label={t("fields.port")} error={form.errors.port} hint={t("fields.portHint")}>
                <Input
                  {...form.field("port")}
                  mono
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={kind === "sftp" ? "22" : "21"}
                />
              </Field>
            </div>
            <Field label={t("fields.username")} error={form.errors.username} hint={t("fields.usernameHint")}>
              <Input {...form.field("username")} mono autoComplete="off" spellCheck={false} />
            </Field>
            <Field
              label={t("fields.password")}
              hint={isEdit ? t("hints.keepSecret") : undefined}
              error={form.errors.password}
              optional={isEdit}
            >
              <PasswordInput {...form.field("password")} autoComplete="new-password" />
            </Field>
            <Field
              label={t("fields.rootPath")}
              hint={t("hints.rootPath")}
              error={form.errors.rootPath}
              optional
            >
              <Input
                {...form.field("rootPath")}
                mono
                autoComplete="off"
                spellCheck={false}
                placeholder="/backups"
              />
            </Field>
            {kind === "ftp" && (
              <Switch
                label={t("fields.tls")}
                hint={t("hints.tls")}
                checked={form.values.tls}
                onCheckedChange={(checked) => form.set("tls", checked)}
              />
            )}
            {hostKeyChanged && (
              <Switch
                label={t("fields.trustNewHostKey")}
                hint={t("hints.trustNewHostKey")}
                checked={form.values.trustNewHostKey}
                onCheckedChange={(checked) => form.set("trustNewHostKey", checked)}
              />
            )}
          </>
        )}

        {s3Info !== null && (
          <>
            <Field
              label={t("fields.accessKeyId")}
              error={form.errors.accessKeyId}
              hint={t("fields.accessKeyIdHint")}
            >
              <Input
                {...form.field("accessKeyId")}
                mono
                autoComplete="off"
                spellCheck={false}
                placeholder="xyz"
              />
            </Field>
            <Field
              label={t("fields.secretAccessKey")}
              hint={isEdit ? t("hints.keepSecret") : undefined}
              error={form.errors.secretAccessKey}
              optional={isEdit}
            >
              <PasswordInput {...form.field("secretAccessKey")} autoComplete="new-password" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("fields.bucket")} error={form.errors.bucket} hint={t("fields.bucketHint")}>
                <Input
                  {...form.field("bucket")}
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="your-bucket-name"
                />
              </Field>
              <Field label={t("fields.region")} error={form.errors.region} hint={t("fields.regionHint")}>
                <Input
                  {...form.field("region")}
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={s3Info.regionPlaceholder}
                />
              </Field>
            </div>
            <Field
              label={t("fields.endpoint")}
              hint={s3Info.endpointRequired ? t("hints.endpointRequired") : t("hints.endpointOptional")}
              error={form.errors.endpoint}
              optional={!s3Info.endpointRequired}
            >
              <Input
                {...form.field("endpoint")}
                mono
                autoComplete="off"
                spellCheck={false}
                placeholder={s3Info.endpointPlaceholder ?? ""}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t("fields.storageClass")}
                hint={t("hints.storageClass", { classes: s3Info.storageClasses.join(", ") })}
                error={form.errors.storageClass}
                optional
              >
                <Input
                  {...form.field("storageClass")}
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("placeholders.default")}
                />
              </Field>
              <Field label={t("fields.prefix")} hint={t("hints.prefix")} error={form.errors.prefix} optional>
                <Input
                  {...form.field("prefix")}
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="backups"
                />
              </Field>
            </div>
          </>
        )}

        {isOAuthKind(kind) &&
          (isEdit ? (
            <p className="text-sm text-muted">{t("oauth.editHint")}</p>
          ) : (
            <>
              <Field
                label={t("fields.clientId")}
                error={form.errors.clientId}
                hint={t("fields.clientIdHint")}
              >
                <Input {...form.field("clientId")} mono autoComplete="off" spellCheck={false} />
              </Field>
              <Field
                label={t("fields.clientSecret")}
                error={form.errors.clientSecret}
                hint={t("fields.clientSecretHint")}
              >
                <PasswordInput {...form.field("clientSecret")} autoComplete="new-password" />
              </Field>
              {redirectUrl !== "" && (
                <Field label={t("fields.redirectUrl")} hint={t(`hints.redirectUrl.${kind}`)}>
                  <MonoValue value={redirectUrl} copy className="break-all text-sm" />
                </Field>
              )}
            </>
          ))}

        {!(isOAuthKind(kind) && isEdit) && (
          <Field label={t("permissions.title")} hint={t("permissions.hint")}>
            <MonoValue value={requiredPermissions[kind].join(", ")} className="break-words text-sm" />
          </Field>
        )}

        {isEdit &&
          editing.builtIn === false &&
          kind === "sftp" &&
          editing.config.kind === "sftp" &&
          editing.config.hostKey !== null && (
            <Field label={t("fields.hostKey")} hint={t("fields.hostKeyHint")}>
              <MonoValue value={editing.config.hostKey} className="break-all text-xs text-muted" />
            </Field>
          )}
      </div>
    </Dialog>
  );
}
