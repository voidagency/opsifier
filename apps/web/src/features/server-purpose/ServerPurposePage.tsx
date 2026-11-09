import {
  type AllowlistEntry,
  type AllowlistKind,
  allowlistKinds,
  createAllowlistEntryRequest,
  createProtectionUserRequest,
  type ProtectedDomain,
  type ProtectionUser,
  type ServerPurpose,
  type ServerPurposeState,
  type ShownOnceCredentials,
  serverPurposes,
  updateProtectionUserRequest,
} from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, schemaErrors, useForm } from "../../lib/forms";
import {
  Button,
  ConfirmDialog,
  countStates,
  Dialog,
  EmptyState,
  Field,
  FormBanner,
  HealthSummary,
  Input,
  Lamp,
  MonoValue,
  PasswordInput,
  Pictogram,
  Segmented,
  Select,
  Skeleton,
  Tooltip,
  toast,
  type VisualState,
} from "../../ui";
import { useCurrentUser } from "../auth/session";
import { allowlistQuery, protectionUsersQuery, purposeApi, purposeQuery, refreshPurpose } from "./api";
import { CredentialsShownOnce } from "./CredentialsShownOnce";
import { purposeLook, stateFromProtection } from "./purpose";

function Section({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-x-10 gap-y-4 border-b px-4 py-6 last:border-b-0 md:px-6 lg:grid-cols-[minmax(0,260px)_minmax(0,620px)] lg:px-8">
      <div>
        <h2 className="text-md font-medium">{title}</h2>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
      <div className="grid min-w-0 gap-4">{children}</div>
    </section>
  );
}

function CredentialsDialog({
  credentials,
  onClose,
}: {
  credentials: ShownOnceCredentials | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("server-purpose");
  return (
    <Dialog
      open={credentials !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      title={t("credentialsOnce.title")}
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("credentialsOnce.done")}
        </Button>
      }
    >
      {credentials !== null && <CredentialsShownOnce credentials={credentials} />}
    </Dialog>
  );
}

function PurposeSection({ state, canEdit }: { state: ServerPurposeState; canEdit: boolean }) {
  const { t } = useTranslation(["server-purpose", "common"]);
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<ServerPurpose | null>(null);
  const [credentials, setCredentials] = useState<ShownOnceCredentials | null>(null);

  const apply = async (purpose: ServerPurpose, confirm?: string) => {
    const result = await purposeApi.set(purpose, confirm);
    await refreshPurpose(queryClient);
    setCredentials(result.credentials);
    toast.success(t("saved", { purpose: t(`purposes.${purpose}`) }));
  };

  const choose = (purpose: ServerPurpose) => {
    if (purpose === state.purpose) {
      return;
    }
    if (purpose === "production" || state.purpose === "production") {
      setTarget(purpose);
      return;
    }
    void apply(purpose).catch((failure: unknown) => toast.error(errorMessage(failure, t)));
  };

  return (
    <Section title={t("purpose.title")} description={t("purpose.description")}>
      {!canEdit && <p className="mb-2 text-sm text-muted">{t("purpose.adminOnly")}</p>}
      <ul className="grid gap-2 sm:grid-cols-3">
        {serverPurposes.map((purpose) => {
          const look = purposeLook[purpose];
          const current = purpose === state.purpose;
          return (
            <li key={purpose} className="contents">
              <button
                type="button"
                aria-pressed={current}
                disabled={!canEdit}
                onClick={() => choose(purpose)}
                className="relative grid gap-2 rounded-sm border p-3 text-left enabled:hover:bg-wash aria-pressed:border-ink"
              >
                <span className="flex items-center gap-2 font-medium" style={{ color: look.color }}>
                  <Pictogram name={look.pictogram} size={20} />
                  <span className="text-ink">{t(`purposes.${purpose}`)}</span>
                </span>
                <span className="text-xs text-muted">{t(`purposeHints.${purpose}`)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {state.purpose === null && <FormBanner tone="info">{t("purpose.unset")}</FormBanner>}

      <ConfirmDialog
        open={target === "production"}
        onOpenChange={(open) => !open && setTarget(null)}
        title={t("toProduction.title")}
        description={t("toProduction.description", { count: state.totalCount })}
        confirmText={state.confirmation}
        confirmLabel={t("toProduction.confirm")}
        onConfirm={() => apply("production", state.confirmation)}
      />
      <ConfirmDialog
        open={target !== null && target !== "production"}
        onOpenChange={(open) => !open && setTarget(null)}
        title={t("leaveProduction.title")}
        description={t("leaveProduction.description", {
          purpose: target === null ? "" : t(`purposes.${target}`),
        })}
        confirmLabel={t("leaveProduction.confirm")}
        tone="primary"
        onConfirm={() => (target === null ? undefined : apply(target))}
      />
      <CredentialsDialog credentials={credentials} onClose={() => setCredentials(null)} />
    </Section>
  );
}

function DomainRow({ domain }: { domain: ProtectedDomain }) {
  const { t } = useTranslation("server-purpose");
  const address = `${domain.wildcard ? "*." : ""}${domain.host}${domain.path === "/" ? "" : domain.path}`;
  const owner = domain.project === "" ? domain.service : `${domain.project}/${domain.service}`;
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b py-2.5 last:border-b-0">
      <Lamp state={stateFromProtection(domain.status)} size="sm" still label={t(`lamp.${domain.status}`)} />
      <MonoValue value={address} truncate className="text-sm" />
      <span className="font-mono text-xs text-muted">{owner}</span>
    </li>
  );
}

function ProtectionSection({ state }: { state: ServerPurposeState }) {
  const { t } = useTranslation(["server-purpose", "common"]);
  const [filter, setFilter] = useState<VisualState | null>(null);
  const states = state.domains.map((domain) => stateFromProtection(domain.status));
  const shown = state.domains.filter(
    (domain) => filter === null || stateFromProtection(domain.status) === filter,
  );

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Pictogram name="shield" size={16} />
          {t("protection.title")}
        </span>
      }
      description={state.protection ? t("protection.description") : t("protection.descriptionProduction")}
    >
      {state.problems.map((problem) => (
        <FormBanner key={`${problem.code}-${problem.file ?? ""}`}>
          {t(`problems.${problem.code}`, { file: problem.file })}
        </FormBanner>
      ))}
      {state.protection && (
        <HealthSummary
          counts={countStates(states)}
          selected={filter}
          onSelect={setFilter}
          label={t("protection.title")}
        />
      )}
      {shown.length === 0 ? (
        <EmptyState title={t("protection.empty.title")} description={t("protection.empty.description")} />
      ) : (
        <ul className="border-y">
          {shown.map((domain) => (
            <DomainRow
              key={`${domain.project}/${domain.service}:${domain.host}${domain.path}`}
              domain={domain}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

function AddUserDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (credentials: ShownOnceCredentials | null) => void;
}) {
  const { t } = useTranslation(["server-purpose", "common"]);
  const queryClient = useQueryClient();
  const form = useForm({
    t,
    initialValues: { username: "", password: "" },
    validate: (values) =>
      schemaErrors<"username" | "password">(
        createProtectionUserRequest,
        { username: values.username, password: values.password === "" ? undefined : values.password },
        { username: t("errors.username"), password: t("errors.password") },
      ),
    onSubmit: async (values) => {
      const result = await purposeApi.addUser({
        username: values.username,
        ...(values.password === "" ? {} : { password: values.password }),
      });
      await refreshPurpose(queryClient);
      form.reset({ username: "", password: "" });
      onAdded(result.credentials);
      toast.success(t("credentials.added"));
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      title={t("credentials.addTitle")}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("credentials.add")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field
          label={t("credentials.username")}
          error={form.errors.username}
          hint={t("credentials.usernameHint")}
        >
          <Input {...form.field("username")} autoComplete="off" spellCheck={false} />
        </Field>
        <Field
          label={t("credentials.password")}
          hint={t("credentials.passwordHint")}
          error={form.errors.password}
          optional
        >
          <PasswordInput {...form.field("password")} autoComplete="new-password" />
        </Field>
      </div>
    </Dialog>
  );
}

function ChangePasswordDialog({
  user,
  onClose,
  onChanged,
}: {
  user: ProtectionUser;
  onClose: () => void;
  onChanged: (credentials: ShownOnceCredentials | null) => void;
}) {
  const { t } = useTranslation(["server-purpose", "common"]);
  const queryClient = useQueryClient();
  const form = useForm({
    t,
    initialValues: { password: "" },
    validate: (values) =>
      schemaErrors<"password">(
        updateProtectionUserRequest,
        { password: values.password === "" ? undefined : values.password },
        { password: t("errors.password") },
      ),
    onSubmit: async (values) => {
      const result = await purposeApi.updateUser(
        user.id,
        values.password === "" ? {} : { password: values.password },
      );
      await refreshPurpose(queryClient);
      toast.success(t("credentials.changed"));
      onChanged(result.credentials);
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      title={t("credentials.rotateTitle")}
      description={t("credentials.rotateDescription", { username: user.username })}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("credentials.rotateConfirm")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field
          label={t("credentials.password")}
          hint={t("credentials.passwordHint")}
          error={form.errors.password}
          optional
        >
          <PasswordInput {...form.field("password")} autoComplete="new-password" />
        </Field>
      </div>
    </Dialog>
  );
}

function CredentialsSection() {
  const { t } = useTranslation(["server-purpose", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(protectionUsersQuery);
  const [adding, setAdding] = useState(false);
  const [rotating, setRotating] = useState<ProtectionUser | null>(null);
  const [removing, setRemoving] = useState<ProtectionUser | null>(null);
  const [shown, setShown] = useState<ShownOnceCredentials | null>(null);

  const body = () => {
    if (isPending) {
      return <Skeleton className="h-6" />;
    }
    if (isError) {
      return (
        <div className="grid justify-items-start gap-3">
          <FormBanner>{errorMessage(error, t)}</FormBanner>
          <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
        </div>
      );
    }
    return (
      <>
        {data.users.length === 0 ? (
          <EmptyState title={t("credentials.empty.title")} description={t("credentials.empty.description")} />
        ) : (
          <ul className="border-y">
            {data.users.map((user) => (
              <li
                key={user.id}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b py-2 last:border-b-0"
              >
                <KeyRound aria-hidden="true" className="size-4 text-muted" />
                <span className="grid min-w-0 gap-0.5">
                  <MonoValue value={user.username} truncate className="text-sm" />
                  <span className="text-xs text-muted">{t("credentials.hidden")}</span>
                </span>
                <span className="flex items-center gap-1">
                  <Tooltip content={t("credentials.rotate")}>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("credentials.rotate")}
                      onClick={() => setRotating(user)}
                    >
                      <RefreshCw aria-hidden="true" className="size-4" />
                    </Button>
                  </Tooltip>
                  <Tooltip content={t("credentials.remove")}>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("credentials.remove")}
                      onClick={() => setRemoving(user)}
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </Button>
                  </Tooltip>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div>
          <Button
            variant="primary"
            icon={<Plus aria-hidden="true" className="size-4" />}
            onClick={() => setAdding(true)}
          >
            {t("credentials.add")}
          </Button>
        </div>
      </>
    );
  };

  return (
    <Section title={t("credentials.title")} description={t("credentials.description")}>
      {body()}

      <AddUserDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(credentials) => setShown(credentials)}
      />
      {rotating !== null && (
        <ChangePasswordDialog
          user={rotating}
          onClose={() => setRotating(null)}
          onChanged={(credentials) => {
            setRotating(null);
            setShown(credentials);
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("credentials.removeTitle")}
        description={t("credentials.removeDescription", { username: removing?.username })}
        confirmLabel={t("credentials.removeConfirm")}
        onConfirm={async () => {
          if (removing !== null) {
            await purposeApi.removeUser(removing.id);
            await refreshPurpose(queryClient);
            toast.success(t("credentials.removed"));
          }
        }}
      />
      <CredentialsDialog credentials={shown} onClose={() => setShown(null)} />
    </Section>
  );
}

function AllowlistRow({ entry, onRemove }: { entry: AllowlistEntry; onRemove: () => void }) {
  const { t } = useTranslation("server-purpose");
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b py-2 last:border-b-0">
      <Lamp state="degraded" size="sm" still label={t("allowlist.warning")} />
      <span className="grid min-w-0 gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <MonoValue value={entry.value} truncate className="text-sm" />
          <span className="text-xs text-muted">{t(`allowlist.kinds.${entry.kind}`)}</span>
        </span>
        <span className="font-mono text-xs text-muted">
          {entry.project}/{entry.service}
        </span>
      </span>
      <Tooltip content={t("allowlist.remove")}>
        <Button size="icon" variant="ghost" aria-label={t("allowlist.remove")} onClick={onRemove}>
          <Trash2 aria-hidden="true" className="size-4" />
        </Button>
      </Tooltip>
    </li>
  );
}

function AllowlistForm({ services }: { services: ReadonlyArray<{ project: string; service: string }> }) {
  const { t } = useTranslation(["server-purpose", "common"]);
  const queryClient = useQueryClient();
  const initial = { target: "", kind: "path" as AllowlistKind, value: "" };
  const form = useForm({
    t,
    initialValues: initial,
    validate: (values) => {
      const [project = "", service = ""] = values.target.split("/");
      const missing = values.target === "" ? { target: t("errors.target") } : {};
      return {
        ...missing,
        ...schemaErrors<"value">(
          createAllowlistEntryRequest,
          { project, service, kind: values.kind, value: values.value },
          { value: values.kind === "path" ? t("errors.path") : t("errors.ip") },
        ),
      };
    },
    onSubmit: async (values) => {
      const [project = "", service = ""] = values.target.split("/");
      await purposeApi.addAllowlistEntry({ project, service, kind: values.kind, value: values.value });
      await refreshPurpose(queryClient);
      form.reset(initial);
      toast.success(t("allowlist.added"));
    },
  });

  return (
    <form onSubmit={form.handleSubmit} noValidate className="grid gap-3">
      {form.banner && <FormBanner>{form.banner}</FormBanner>}
      <Field label={t("allowlist.service")} error={form.errors.target} hint={t("allowlist.serviceHint")}>
        <Select
          value={form.values.target}
          onValueChange={(value) => form.set("target", value)}
          placeholder={t("allowlist.servicePlaceholder")}
          options={services.map(({ project, service }) => ({
            value: `${project}/${service}`,
            label: `${project}/${service}`,
          }))}
        />
      </Field>
      <Field label={t("allowlist.kind")} hint={t("allowlist.kindHint")}>
        <Segmented
          label={t("allowlist.kind")}
          value={form.values.kind}
          onChange={(value) => form.set("kind", value)}
          options={allowlistKinds.map((kind) => ({ value: kind, label: t(`allowlist.kinds.${kind}`) }))}
        />
      </Field>
      <Field
        label={t(`allowlist.${form.values.kind}`)}
        hint={t(`allowlist.${form.values.kind}Hint`)}
        error={form.errors.value}
      >
        <Input {...form.field("value")} mono autoComplete="off" spellCheck={false} />
      </Field>
      <div>
        <Button type="submit" pending={form.pending} icon={<Plus aria-hidden="true" className="size-4" />}>
          {t("allowlist.add")}
        </Button>
      </div>
    </form>
  );
}

function AllowlistSection() {
  const { t } = useTranslation(["server-purpose", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(allowlistQuery);
  const [removing, setRemoving] = useState<AllowlistEntry | null>(null);

  return (
    <Section title={t("allowlist.title")} description={t("allowlist.description")}>
      <FormBanner tone="warning">{t("allowlist.warning")}</FormBanner>
      {isPending ? (
        <Skeleton className="h-6" />
      ) : isError ? (
        <div className="grid justify-items-start gap-3">
          <FormBanner>{errorMessage(error, t)}</FormBanner>
          <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
        </div>
      ) : (
        <>
          {data.entries.length === 0 ? (
            <p className="text-sm text-muted">{t("allowlist.empty")}</p>
          ) : (
            <ul className="border-y">
              {data.entries.map((entry) => (
                <AllowlistRow key={entry.id} entry={entry} onRemove={() => setRemoving(entry)} />
              ))}
            </ul>
          )}
          <AllowlistForm services={data.services} />
        </>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("allowlist.removeTitle")}
        description={t("allowlist.removeDescription", { value: removing?.value })}
        confirmLabel={t("allowlist.removeConfirm")}
        tone="primary"
        onConfirm={async () => {
          if (removing !== null) {
            await purposeApi.removeAllowlistEntry(removing.id);
            await refreshPurpose(queryClient);
            toast.success(t("allowlist.removed"));
          }
        }}
      />
    </Section>
  );
}

function CertificatesSection() {
  const { t } = useTranslation("server-purpose");
  return (
    <Section title={t("certificates.title")} description={t("certificates.description")}>
      <div className="flex items-start gap-3 rounded-sm border p-3">
        <Pictogram name="certificate" size={20} />
        <p className="text-sm">{t("certificates.advice")}</p>
      </div>
    </Section>
  );
}

/** Settings > Server > Purpose. Problems in the report come first, as they do everywhere. */
export function ServerPurposePage() {
  const { t } = useTranslation(["server-purpose", "common"]);
  const { data: state, isPending, isError, error, refetch } = useQuery(purposeQuery);
  const user = useCurrentUser();
  const canEdit = user?.role === "admin";

  if (isPending) {
    return (
      <div className="grid max-w-[900px] gap-3 px-4 py-6 md:px-6 lg:px-8">
        <Skeleton className="h-6" />
        <Skeleton className="h-20" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="grid max-w-[650px] justify-items-start gap-3 px-4 py-6 md:px-6 lg:px-8">
        <FormBanner>{errorMessage(error, t)}</FormBanner>
        <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
      </div>
    );
  }

  return (
    <div>
      <PurposeSection state={state} canEdit={canEdit} />
      <ProtectionSection state={state} />
      {canEdit && <CredentialsSection />}
      {canEdit && <AllowlistSection />}
      <CertificatesSection />
    </div>
  );
}
