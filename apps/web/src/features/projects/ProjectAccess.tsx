import { effectiveProjectRole, type ProjectMember, type ProjectRole } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { Trash2, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, useForm } from "../../lib/forms";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Field,
  FormBanner,
  Lamp,
  MonoValue,
  Pictogram,
  Select,
  Skeleton,
  Tooltip,
  toast,
} from "../../ui";
import { usersQuery } from "../settings/server/api";
import { RoleSelect } from "../settings/server/GrantsEditor";
import { projectMembersQuery, projectsApi } from "./api";

const RANK = { none: 0, viewer: 1, operator: 2, admin: 3 } as const;
const rankOf = (role: keyof typeof RANK | null) => RANK[role ?? "none"];

/** A change that would leave a member with less than it has here, waiting for a confirmation. */
interface Lowering {
  member: ProjectMember;
  grant: ProjectRole | null;
}

/** Where a member's role here comes from, in a few words. */
function originOf(member: ProjectMember, roleName: (role: ProjectRole) => string, t: TFunction): string {
  if (member.administrator) {
    return t("settings.access.asAdministrator");
  }
  if (member.allProjects === null) {
    return t("settings.access.ownRole");
  }
  if (member.role !== member.allProjects && member.role !== "admin") {
    return t("settings.access.raisedHere", {
      role: roleName(member.allProjects),
      here: roleName(member.role),
    });
  }
  return t("settings.access.everyProject", { role: roleName(member.allProjects) });
}

function MemberRow({
  member,
  project,
  onChange,
}: {
  member: ProjectMember;
  project: string;
  onChange: (grant: ProjectRole | null) => void;
}) {
  const { t } = useTranslation(["projects", "settings-access"]);
  const roleName = (role: ProjectRole) => t(`settings-access:users.roles.${role}`);
  // An administrator, or an operator in every project, has nothing a project can add or take away.
  const settable = !member.administrator && member.allProjects !== "operator" && member.role !== "admin";
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b py-2.5 last:border-b-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
      <Pictogram name="user" size={20} />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2">
          {member.name !== "" && <span className="text-sm">{member.name}</span>}
          <MonoValue value={member.email} className="truncate text-sm" />
          {!member.active && (
            <Lamp state="stopped" label={t("settings-access:users.deactivated")} showLabel />
          )}
          {member.administrator ? (
            <Badge tone="accent">
              {t(member.owner ? "settings-access:users.roles.owner" : "settings-access:users.roles.admin")}
            </Badge>
          ) : (
            !settable && <Badge>{roleName(member.role === "admin" ? "operator" : member.role)}</Badge>
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted">{originOf(member, roleName, t)}</p>
      </div>
      {settable && member.role !== "admin" && (
        <div className="col-start-2 flex items-center gap-1 sm:col-start-auto">
          <RoleSelect
            label={t("settings.access.roleOf", { email: member.email, project })}
            value={member.role}
            // What every project gives already needs no role of the project's own.
            onChange={(role) => onChange(role === member.allProjects ? null : role)}
          />
          {member.allProjects === null && (
            <Tooltip content={t("settings.access.remove", { email: member.email })}>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("settings.access.remove", { email: member.email })}
                onClick={() => onChange(null)}
              >
                <Trash2 aria-hidden="true" className="size-4" />
              </Button>
            </Tooltip>
          )}
        </div>
      )}
    </li>
  );
}

function AddMemberDialog({
  open,
  onOpenChange,
  project,
  members,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: string;
  members: readonly ProjectMember[];
  onAdd: (userId: string, role: ProjectRole) => Promise<void>;
}) {
  const { t } = useTranslation(["projects", "common"]);
  const { data, isPending, isError, error } = useQuery({ ...usersQuery, enabled: open });
  const reached = new Set(members.map((member) => member.id));
  const candidates = data?.users.filter((user) => user.role === "member" && !reached.has(user.id)) ?? [];
  const [role, setRole] = useState<ProjectRole>("viewer");
  const form = useForm({
    t,
    initialValues: { account: "" },
    validate: ({ account }) => (account === "" ? { account: t("settings.access.chooseAccount") } : {}),
    onSubmit: async ({ account }) => {
      await onAdd(account, role);
      onOpenChange(false);
    },
  });
  const { reset } = form;

  useEffect(() => {
    if (open) {
      reset({ account: "" });
      setRole("viewer");
    }
  }, [open, reset]);

  const ready = !isPending && !isError && candidates.length > 0;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("settings.access.addTitle", { project })}
      onSubmit={ready ? form.handleSubmit : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          {ready && (
            <Button type="submit" variant="primary" pending={form.pending}>
              {t("settings.access.submit")}
            </Button>
          )}
        </>
      }
    >
      {isPending ? (
        <Skeleton className="h-16" />
      ) : isError ? (
        <FormBanner>{errorMessage(error, t)}</FormBanner>
      ) : candidates.length === 0 ? (
        <p className="text-sm text-muted">{t("settings.access.nobodyToAdd")}</p>
      ) : (
        <div className="grid gap-4">
          {form.banner && <FormBanner>{form.banner}</FormBanner>}
          <Field
            label={t("settings.access.account")}
            hint={t("settings.access.accountHint")}
            error={form.errors.account}
          >
            <Select
              value={form.values.account}
              onValueChange={(value) => form.set("account", value)}
              placeholder={t("settings.access.chooseAccount")}
              options={candidates.map((user) => ({
                value: user.id,
                label: user.name === "" ? user.email : `${user.name} · ${user.email}`,
              }))}
            />
          </Field>
          <Field label={t("settings.access.role")} hint={t("settings.access.roleHint")}>
            <RoleSelect label={t("settings.access.role")} value={role} onChange={setRole} />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

/**
 * Who reaches a project and as what, for an administrator, with the project's own roles to give,
 * change or take away. A role in every project and an administrator's reach are shown, and changed
 * on the account itself.
 */
export function ProjectAccess({ project }: { project: string }) {
  const { t } = useTranslation(["projects", "common"]);
  const queryClient = useQueryClient();
  const members = projectMembersQuery(project);
  const { data, isPending, isError, error, refetch } = useQuery(members);
  const [adding, setAdding] = useState(false);
  const [lowering, setLowering] = useState<Lowering | null>(null);

  const save = async (userId: string, grant: ProjectRole | null) => {
    queryClient.setQueryData(members.queryKey, await projectsApi.setMember(project, userId, grant));
    await queryClient.invalidateQueries({ queryKey: ["users"] });
    toast.success(t("settings.access.saved"));
  };

  const change = (member: ProjectMember, grant: ProjectRole | null) => {
    // Less than it has now ends its sessions and keys, so that is confirmed first.
    if (rankOf(effectiveProjectRole(member.allProjects, grant)) < rankOf(member.role)) {
      setLowering({ member, grant });
      return;
    }
    save(member.id, grant).catch((reason: unknown) => toast.error(errorMessage(reason, t)));
  };

  if (isPending) {
    return <Skeleton className="h-24" />;
  }
  if (isError) {
    return <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />;
  }

  const removing =
    lowering !== null && effectiveProjectRole(lowering.member.allProjects, lowering.grant) === null;
  return (
    <div className="grid gap-3">
      <ul className="border-t">
        {data.members.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            project={project}
            onChange={(grant) => change(member, grant)}
          />
        ))}
      </ul>
      {data.members.every((member) => member.administrator) && (
        <p className="text-sm text-muted">{t("settings.access.onlyAdministrators")}</p>
      )}
      <div>
        <Button icon={<UserPlus aria-hidden="true" className="size-4" />} onClick={() => setAdding(true)}>
          {t("settings.access.add")}
        </Button>
      </div>
      <AddMemberDialog
        open={adding}
        onOpenChange={setAdding}
        project={project}
        members={data.members}
        onAdd={(userId, role) => save(userId, role)}
      />
      <ConfirmDialog
        open={lowering !== null}
        onOpenChange={(open) => !open && setLowering(null)}
        tone="danger"
        title={
          lowering === null
            ? ""
            : removing
              ? t("settings.access.removeTitle", { email: lowering.member.email, project })
              : t("settings.access.lowerTitle", { email: lowering.member.email })
        }
        description={t("settings.access.lowerDescription")}
        confirmLabel={removing ? t("settings.access.confirmRemove") : t("settings.access.lower")}
        onConfirm={() => (lowering === null ? false : save(lowering.member.id, lowering.grant))}
      />
    </div>
  );
}
