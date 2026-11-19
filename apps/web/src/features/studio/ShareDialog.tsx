import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import { Button, Checkbox, Dialog, FormBanner, Skeleton, toast } from "../../ui";
import { usersQuery } from "../settings/server/api";
import { studioApi, studioKey, studioMembersQuery } from "./api";

/**
 * Shares a Studio project with the panel's member accounts: each one ticked sees the project in the
 * Studio, its conversations and its preview, and nothing else of the server. Administrators see
 * every project already, so they are not listed.
 */
export function ShareDialog({
  project,
  service,
  onClose,
}: {
  project: string;
  service: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["studio", "common"]);
  const queryClient = useQueryClient();
  const users = useQuery(usersQuery);
  const members = useQuery(studioMembersQuery(project, service));
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const current = chosen ?? new Set(members.data?.members.map((member) => member.userId) ?? []);
  const candidates = (users.data?.users ?? [])
    .filter((user) => user.role === "member" && user.active)
    .sort((a, b) => a.email.localeCompare(b.email));
  const loading = users.isPending || members.isPending;

  const toggle = (id: string, on: boolean) => {
    const next = new Set(current);
    if (on) {
      next.add(id);
    } else {
      next.delete(id);
    }
    setChosen(next);
  };

  const save = async () => {
    setSaving(true);
    setFailure(null);
    try {
      const saved = await studioApi.setMembers(project, service, { userIds: [...current] });
      await queryClient.invalidateQueries({ queryKey: studioKey });
      toast.success(t("share.saved", { count: saved.members.length }));
      onClose();
    } catch (reason) {
      setFailure(errorMessage(reason, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !saving && onClose()}
      size="sm"
      title={t("share.title", { name: service })}
      description={t("share.description")}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={saving} disabled={loading}>
            {t("share.save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {failure !== null && <FormBanner>{failure}</FormBanner>}
        {users.isError || members.isError ? (
          <FormBanner>{errorMessage(users.error ?? members.error, t)}</FormBanner>
        ) : loading ? (
          <Skeleton className="h-24" />
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted">{t("share.none")}</p>
        ) : (
          <ul aria-label={t("share.accounts")} className="relative grid max-h-72 gap-2 overflow-y-auto">
            {candidates.map((user) => (
              <li key={user.id}>
                <Checkbox
                  label={user.name === "" ? user.email : `${user.name} · ${user.email}`}
                  checked={current.has(user.id)}
                  onChange={(event) => toggle(user.id, event.currentTarget.checked)}
                />
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">{t("share.admins")}</p>
      </div>
    </Dialog>
  );
}
