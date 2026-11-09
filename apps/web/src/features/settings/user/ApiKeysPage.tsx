import type { ApiKey, ApiKeyLevel, CreateApiKeyRequest, CreatedApiKey } from "@opsifier/contract";
import { API_KEY_DEFAULT_DAYS, API_KEY_MAX_DAYS } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BookOpen, KeyRound, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../../lib/format";
import { errorMessage, useForm } from "../../../lib/forms";
import {
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  CopyButton,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormBanner,
  Input,
  Lamp,
  Segmented,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Tooltip,
  TR,
  toast,
} from "../../../ui";
import { useCurrentUser } from "../../auth/session";
import { projectsQuery } from "../../projects/api";
import { accessApi, myKeysQuery } from "../server/api";

/** The moment a key is created is the only moment its secret exists anywhere readable. */
export function KeySecretDialog({ secret, onClose }: { secret: CreatedApiKey | null; onClose: () => void }) {
  const { t } = useTranslation(["settings-access", "common"]);
  return (
    <Dialog
      open={secret !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t("keys.createdTitle")}
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("keys.done")}
        </Button>
      }
    >
      <div className="grid gap-3">
        <FormBanner tone="success">{t("keys.shownOnce")}</FormBanner>
        <Field label={t("keys.secret")} hint={t("keys.secretHint")}>
          <div className="flex items-center gap-2">
            <Input
              mono
              readOnly
              value={secret?.token ?? ""}
              onFocus={(event) => event.currentTarget.select()}
            />
            <CopyButton value={secret?.token ?? ""} />
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

export function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: CreatedApiKey) => void;
}) {
  const { t } = useTranslation(["settings-access", "common"]);
  const queryClient = useQueryClient();
  const user = useCurrentUser();
  const { data } = useQuery({ ...projectsQuery, enabled: open });
  const projects = data?.projects.map((project) => project.name) ?? [];
  const [level, setLevel] = useState<ApiKeyLevel>("read");
  const [scope, setScope] = useState<string[] | null>(null);
  const form = useForm({
    t,
    initialValues: { name: "", expiresInDays: String(API_KEY_DEFAULT_DAYS) },
    validate: ({ name, expiresInDays }) => {
      const errors: Partial<Record<"name" | "expiresInDays", string>> = {};
      if (name.trim() === "") {
        errors.name = t("errors.required");
      }
      const days = Number(expiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > API_KEY_MAX_DAYS) {
        errors.expiresInDays = t("keys.errors.days", { max: API_KEY_MAX_DAYS });
      }
      return errors;
    },
    onSubmit: async ({ name, expiresInDays }) => {
      const body: CreateApiKeyRequest = {
        name,
        level,
        expiresInDays: Number(expiresInDays),
        projects: scope,
      };
      const created = await accessApi.createKey(body);
      await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      onOpenChange(false);
      onCreated(created);
    },
  });
  const { reset } = form;

  useEffect(() => {
    if (open) {
      reset({ name: "", expiresInDays: String(API_KEY_DEFAULT_DAYS) });
      setLevel("read");
      setScope(null);
    }
  }, [open, reset]);

  const toggleProject = (project: string, checked: boolean) =>
    setScope((current) => {
      const list = current ?? [];
      const next = checked ? [...list, project] : list.filter((name) => name !== project);
      return next.length === 0 ? null : next;
    });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("keys.createTitle")}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("keys.create")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("keys.name")} error={form.errors.name} hint={t("keys.nameHint")}>
          <Input {...form.field("name")} autoFocus maxLength={64} />
        </Field>
        <Field label={t("keys.level")} hint={t("keys.levelHint")}>
          <Segmented
            label={t("keys.level")}
            value={level}
            onChange={setLevel}
            options={[
              { value: "read", label: t("keys.levels.read") },
              { value: "write", label: t("keys.levels.write") },
            ]}
          />
        </Field>
        <Field
          label={t("keys.expires")}
          error={form.errors.expiresInDays}
          hint={t("keys.expiresHint", { max: API_KEY_MAX_DAYS })}
        >
          <Input {...form.field("expiresInDays")} inputMode="numeric" className="w-24" />
        </Field>
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">{t("keys.scope")}</legend>
          <p className="text-xs text-muted">
            {user?.role === "admin" ? t("keys.scopeHintAdmin") : t("keys.scopeHint")}
          </p>
          <div className="grid max-h-44 gap-1.5 overflow-y-auto">
            {projects.map((project) => (
              <Checkbox
                key={project}
                label={<span className="font-mono text-xs">{project}</span>}
                checked={scope?.includes(project) ?? false}
                onChange={(event) => toggleProject(project, event.currentTarget.checked)}
              />
            ))}
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}

export function KeyRow({ apiKey, onRevoke }: { apiKey: ApiKey; onRevoke: () => void }) {
  const { t, i18n } = useTranslation("settings-access");
  const expired = Date.parse(apiKey.expiresAt) <= Date.now();
  return (
    <TR>
      <TD>
        <span className="flex items-center gap-2">
          <Lamp
            state={expired ? "stopped" : "running"}
            size="xs"
            still
            label={expired ? t("keys.expired") : t("keys.active")}
          />
          {apiKey.name}
        </span>
      </TD>
      <TD mono className="text-muted">{`${apiKey.prefix}…`}</TD>
      <TD>
        <Badge tone={apiKey.level === "write" ? "accent" : "neutral"}>
          {t(`keys.levels.${apiKey.level}`)}
        </Badge>
      </TD>
      <TD className="text-xs text-muted">
        {apiKey.projects === null ? t("keys.allProjects") : apiKey.projects.join(", ")}
      </TD>
      <TD className="text-xs text-muted">
        {apiKey.lastUsedAt === null
          ? t("keys.neverUsed")
          : formatRelativeTime(apiKey.lastUsedAt, i18n.language)}
      </TD>
      <TD className="text-xs text-muted">{formatRelativeTime(apiKey.expiresAt, i18n.language)}</TD>
      <TD className="text-right">
        <Tooltip content={t("keys.revoke")}>
          <Button size="icon-sm" variant="ghost" aria-label={t("keys.revoke")} onClick={onRevoke}>
            <Trash2 aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
      </TD>
    </TR>
  );
}

export function KeysTable({ keys, onRevoke }: { keys: readonly ApiKey[]; onRevoke: (key: ApiKey) => void }) {
  const { t } = useTranslation("settings-access");
  return (
    <Table>
      <THead>
        <TR>
          <TH>{t("keys.name")}</TH>
          <TH>{t("keys.prefix")}</TH>
          <TH>{t("keys.level")}</TH>
          <TH>{t("keys.scope")}</TH>
          <TH>{t("keys.lastUsed")}</TH>
          <TH>{t("keys.expires")}</TH>
          <TH>
            <span className="sr-only">{t("keys.revoke")}</span>
          </TH>
        </TR>
      </THead>
      <TBody>
        {keys.map((key) => (
          <KeyRow key={key.id} apiKey={key} onRevoke={() => onRevoke(key)} />
        ))}
      </TBody>
    </Table>
  );
}

/** Your own API keys: the secret once at creation, and only ever a hash on the server. */
export function ApiKeysPage() {
  const { t } = useTranslation(["settings-access", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(myKeysQuery);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const revoke = async () => {
    if (revoking === null) {
      return false;
    }
    await accessApi.revokeMyKey(revoking.id);
    await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    toast.success(t("keys.revoked"));
    return true;
  };

  const createButton = (
    <Button
      variant="primary"
      icon={<Plus aria-hidden="true" className="size-4" />}
      onClick={() => setCreating(true)}
    >
      {t("keys.new")}
    </Button>
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 px-4 py-6 md:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-md font-medium">
            <KeyRound aria-hidden="true" className="size-4" />
            {t("keys.title")}
          </h2>
          <p className="mt-1 max-w-[60ch] text-sm text-muted">{t("keys.description")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/settings/user/api"
            className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-off px-3 text-sm hover:bg-wash"
          >
            <BookOpen aria-hidden="true" className="size-4" />
            {t("keys.reference")}
          </Link>
          {createButton}
        </div>
      </div>
      {isPending ? (
        <Skeleton className="h-24" />
      ) : isError ? (
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      ) : data.keys.length === 0 ? (
        <EmptyState
          illustration="no-activity"
          title={t("keys.emptyTitle")}
          description={t("keys.emptyDescription")}
          action={createButton}
        />
      ) : (
        <KeysTable keys={data.keys} onRevoke={setRevoking} />
      )}
      <CreateKeyDialog open={creating} onOpenChange={setCreating} onCreated={setSecret} />
      <KeySecretDialog secret={secret} onClose={() => setSecret(null)} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("keys.revokeTitle")}
        description={revoking === null ? undefined : t("keys.revokeDescription", { name: revoking.name })}
        confirmLabel={t("keys.revoke")}
        onConfirm={revoke}
      />
    </div>
  );
}
