import type {
  ApiKey,
  CreatedApiKey,
  PanelUser,
  ProjectGrant,
  ProjectRole,
  UserRole,
} from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, MailPlus, Pencil, Plus, ShieldCheck, Trash2, UserCheck, UserX } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../../lib/format";
import { errorMessage, useForm } from "../../../lib/forms";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormBanner,
  Input,
  Lamp,
  MonoValue,
  PasswordInput,
  Pictogram,
  Segmented,
  Skeleton,
  Switch,
  Tooltip,
  toast,
} from "../../../ui";
import { useCurrentUser } from "../../auth/session";
import { CreateKeyDialog, KeySecretDialog, KeysTable } from "../user/ApiKeysPage";
import { accessApi, userKeysQuery, usersQuery } from "./api";
import { GrantsEditor, reachSummary } from "./GrantsEditor";
import { InviteDialog } from "./invitations/InviteDialog";
import { PendingInvitations } from "./invitations/PendingInvitations";
import { TwoFactorPolicySection } from "./TwoFactorPolicySection";

function UserDialog({
  open,
  onOpenChange,
  user,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: PanelUser | null;
}) {
  const { t } = useTranslation(["settings-access", "common"]);
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  const isSelf = user !== null && currentUser?.id === user.id;
  const { data: everyone } = useQuery(usersQuery);
  const canGrantHost = everyone?.users.find((candidate) => candidate.id === currentUser?.id)?.owner === true;
  const [role, setRole] = useState<UserRole>("member");
  const [grants, setGrants] = useState<ProjectGrant[]>([]);
  const [allProjects, setAllProjects] = useState<ProjectRole | null>(null);
  const [hostAdmin, setHostAdmin] = useState(false);
  const form = useForm({
    t,
    initialValues: { email: "", password: "" },
    validate: ({ email, password }) => {
      const errors: Partial<Record<"email" | "password", string>> = {};
      if (!/^\S+@\S+\.\S+$/.test(email)) {
        errors.email = t("errors.email");
      }
      if (user === null ? password.length < 12 : password !== "" && password.length < 12) {
        errors.password = t("errors.password");
      }
      return errors;
    },
    onSubmit: async ({ email, password }) => {
      const member = role === "member";
      if (user === null) {
        await accessApi.createUser({
          email,
          password,
          role,
          projects: member ? grants : [],
          allProjects: member ? allProjects : null,
        });
      } else {
        await accessApi.updateUser(user.id, {
          email,
          role,
          projects: member ? grants : [],
          allProjects: member ? allProjects : null,
          ...(password === "" ? {} : { password }),
          ...(canGrantHost && !user.owner ? { hostAdmin } : {}),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      toast.success(t(user === null ? "users.createdDone" : "users.updated"));
      onOpenChange(false);
    },
  });
  const { reset } = form;

  useEffect(() => {
    if (open) {
      reset({ email: user?.email ?? "", password: "" });
      setRole(user?.role ?? "member");
      setGrants(user?.projects ?? []);
      setAllProjects(user?.allProjects ?? null);
      setHostAdmin(user?.hostAdmin ?? false);
    }
  }, [open, user, reset]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(user === null ? "users.createTitle" : "users.editTitle")}
      size="lg"
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t(user === null ? "users.create" : "users.save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field
          label={t("users.email")}
          hint={isSelf ? t("users.changeOwnAccount") : undefined}
          error={form.errors.email}
        >
          <Input {...form.field("email")} autoComplete="off" disabled={isSelf} />
        </Field>
        <Field
          label={t("users.password")}
          error={form.errors.password}
          hint={
            isSelf
              ? t("users.changeOwnAccount")
              : user === null
                ? t("users.passwordHint")
                : t("users.passwordKeep")
          }
        >
          <PasswordInput {...form.field("password")} autoComplete="new-password" disabled={isSelf} />
        </Field>
        <Field label={t("users.role")} hint={t("users.roleHint")}>
          <Segmented
            label={t("users.role")}
            value={role}
            onChange={setRole}
            options={[
              { value: "member", label: t("users.roles.member") },
              { value: "admin", label: t("users.roles.admin") },
            ]}
          />
        </Field>
        {role === "member" && (
          <GrantsEditor
            grants={grants}
            onChange={setGrants}
            allProjects={allProjects}
            onAllProjectsChange={setAllProjects}
          />
        )}
        {role === "admin" && user !== null && (
          <Switch
            label={t("users.hostAdmin")}
            hint={
              user.owner
                ? t("users.hostAdminOwner")
                : canGrantHost
                  ? t("users.hostAdminHint")
                  : t("users.hostAdminOwnerOnly")
            }
            checked={user.owner || hostAdmin}
            onCheckedChange={setHostAdmin}
            disabled={user.owner || !canGrantHost}
          />
        )}
      </div>
    </Dialog>
  );
}

function UserKeysDialog({ user, onClose }: { user: PanelUser | null; onClose: () => void }) {
  const { t } = useTranslation(["settings-access", "common"]);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error } = useQuery({
    ...userKeysQuery(user?.id ?? ""),
    enabled: user !== null,
  });
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const revoke = async () => {
    if (user === null || revoking === null) {
      return false;
    }
    await accessApi.revokeUserKey(user.id, revoking.id);
    await queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    await queryClient.invalidateQueries({ queryKey: ["users"] });
    toast.success(t("keys.revoked"));
    return true;
  };

  return (
    <Dialog
      open={user !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t("users.keysTitle", { email: user?.email ?? "" })}
      size="lg"
      footer={<Button onClick={onClose}>{t("common:actions.close")}</Button>}
    >
      {isPending ? (
        <Skeleton className="h-16" />
      ) : isError ? (
        <FormBanner>{errorMessage(error, t)}</FormBanner>
      ) : data.keys.length === 0 ? (
        <p className="text-sm text-muted">{t("users.noKeys")}</p>
      ) : (
        <KeysTable keys={data.keys} onRevoke={setRevoking} />
      )}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("keys.revokeTitle")}
        description={revoking === null ? undefined : t("keys.revokeDescription", { name: revoking.name })}
        confirmLabel={t("keys.revoke")}
        onConfirm={revoke}
      />
    </Dialog>
  );
}

function UserRow({
  user,
  self,
  onEdit,
  onDelete,
  onActive,
  onKeys,
  onGenerateKey,
}: {
  user: PanelUser;
  self: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onActive: () => void;
  onKeys: () => void;
  onGenerateKey: () => void;
}) {
  const { t, i18n } = useTranslation("settings-access");
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b py-2.5 last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <Pictogram name="user" size={20} />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2">
          {user.name !== "" && <span className="text-sm">{user.name}</span>}
          <MonoValue value={user.email} className="truncate text-sm" />
          {!user.active && <Lamp state="stopped" label={t("users.deactivated")} showLabel />}
          {user.owner ? (
            <Badge tone="accent">{t("users.roles.owner")}</Badge>
          ) : (
            <Badge tone={user.role === "admin" ? "accent" : "neutral"}>{t(`users.roles.${user.role}`)}</Badge>
          )}
          {user.hostAdmin && !user.owner && <Badge>{t("users.hostAdmin")}</Badge>}
          {user.twoFactorEnabled && (
            <Tooltip content={t("users.twoFactorOn")}>
              <span aria-label={t("users.twoFactorOn")} role="img">
                <ShieldCheck aria-hidden="true" className="size-4 text-ok" />
              </span>
            </Tooltip>
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {reachSummary(user, t)}
          {" · "}
          {t("users.created", { when: formatRelativeTime(user.createdAt, i18n.language) })}
        </p>
      </div>
      <div className="col-start-2 flex flex-wrap items-center gap-0.5 sm:col-start-auto">
        {self && (
          <Button size="sm" onClick={onGenerateKey}>
            {t("users.generateKey")}
          </Button>
        )}
        <Tooltip content={t("users.manageKeys")}>
          <Button size="icon" variant="ghost" aria-label={t("users.manageKeys")} onClick={onKeys}>
            <KeyRound aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
        <Tooltip content={t("users.edit")}>
          <Button size="icon" variant="ghost" aria-label={t("users.edit")} onClick={onEdit}>
            <Pencil aria-hidden="true" className="size-4" />
          </Button>
        </Tooltip>
        {!user.owner && !self && (
          <Tooltip content={t(user.active ? "users.deactivate" : "users.reactivate")}>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t(user.active ? "users.deactivate" : "users.reactivate")}
              onClick={onActive}
            >
              {user.active ? (
                <UserX aria-hidden="true" className="size-4" />
              ) : (
                <UserCheck aria-hidden="true" className="size-4" />
              )}
            </Button>
          </Tooltip>
        )}
        {!user.owner && !self && (
          <Tooltip content={t("users.delete")}>
            <Button size="icon" variant="ghost" aria-label={t("users.delete")} onClick={onDelete}>
              <Trash2 aria-hidden="true" className="size-4" />
            </Button>
          </Tooltip>
        )}
      </div>
    </li>
  );
}

/** Who can sign in, what each person can reach, and the API keys acting for them. */
export function UsersPage() {
  const { t } = useTranslation(["settings-access", "common"]);
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  const { data, isPending, isError, error, refetch } = useQuery(usersQuery);
  const [creating, setCreating] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<PanelUser | null>(null);
  const [deleting, setDeleting] = useState<PanelUser | null>(null);
  const [deactivating, setDeactivating] = useState<PanelUser | null>(null);
  const [keysOf, setKeysOf] = useState<PanelUser | null>(null);
  const [secret, setSecret] = useState<CreatedApiKey | null>(null);
  const [generating, setGenerating] = useState(false);

  const remove = async () => {
    if (deleting === null) {
      return false;
    }
    await accessApi.deleteUser(deleting.id, deleting.email);
    await queryClient.invalidateQueries({ queryKey: ["users"] });
    toast.success(t("users.deleted"));
    return true;
  };

  const setActive = async (user: PanelUser, active: boolean) => {
    await accessApi.setUserActive(user.id, active);
    await queryClient.invalidateQueries({ queryKey: ["users"] });
    toast.success(t(active ? "users.reactivated" : "users.deactivatedDone", { email: user.email }));
    return true;
  };

  const reactivate = (user: PanelUser) => {
    setActive(user, true).catch((reason: unknown) => toast.error(errorMessage(reason, t)));
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 px-4 py-6 md:px-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-md font-medium">{t("users.title")}</h2>
          <p className="mt-1 max-w-[60ch] text-sm text-muted">{t("users.description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<Plus aria-hidden="true" className="size-4" />} onClick={() => setCreating(true)}>
            {t("users.new")}
          </Button>
          <Button
            variant="primary"
            icon={<MailPlus aria-hidden="true" className="size-4" />}
            onClick={() => setInviting(true)}
          >
            {t("invitations.invite")}
          </Button>
        </div>
      </div>
      <TwoFactorPolicySection />
      {isPending ? (
        <Skeleton className="h-24" />
      ) : isError ? (
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      ) : data.users.length === 0 ? (
        <EmptyState illustration="no-activity" title={t("users.emptyTitle")} />
      ) : (
        <ul className="border-t">
          {data.users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              self={user.id === currentUser?.id}
              onEdit={() => setEditing(user)}
              onDelete={() => setDeleting(user)}
              onActive={() => (user.active ? setDeactivating(user) : reactivate(user))}
              onKeys={() => setKeysOf(user)}
              onGenerateKey={() => setGenerating(true)}
            />
          ))}
        </ul>
      )}
      <PendingInvitations />
      <InviteDialog open={inviting} onOpenChange={setInviting} />
      <UserDialog
        open={creating || editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        user={editing}
      />
      <UserKeysDialog user={keysOf} onClose={() => setKeysOf(null)} />
      <KeySecretDialog secret={secret} onClose={() => setSecret(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("users.deleteTitle")}
        description={deleting === null ? undefined : t("users.deleteDescription", { email: deleting.email })}
        confirmLabel={t("users.delete")}
        confirmText={deleting?.email}
        onConfirm={remove}
      />
      <ConfirmDialog
        open={deactivating !== null}
        onOpenChange={(open) => !open && setDeactivating(null)}
        title={t("users.deactivateTitle")}
        description={
          deactivating === null ? undefined : t("users.deactivateDescription", { email: deactivating.email })
        }
        confirmLabel={t("users.deactivate")}
        onConfirm={() => (deactivating === null ? false : setActive(deactivating, false))}
      />
      <CreateKeyDialog open={generating} onOpenChange={setGenerating} onCreated={setSecret} />
    </div>
  );
}
