import type { StudioGithubKey } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, useForm } from "../../lib/forms";
import {
  Button,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Field,
  FormBanner,
  Input,
  Skeleton,
  toast,
} from "../../ui";
import { studioApi, studioGithubKeysQuery } from "./api";

/**
 * The Studio's GitHub keys: a token for each account or organization whose repositories the Studio
 * works on, since a fine-grained token reaches one owner only. Tokens go in and never come back.
 */
export function GithubKeysSection({ ownAgents }: { ownAgents: boolean }) {
  const { t } = useTranslation(["studio", "common"]);
  const { data, isPending, isError, error, refetch } = useQuery(studioGithubKeysQuery);
  const [adding, setAdding] = useState(false);

  return (
    <section className="grid max-w-[620px] gap-3 border-t pt-5" aria-labelledby="studio-github-keys-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 id="studio-github-keys-title" className="font-medium">
            {t("githubKeys.title")}
          </h3>
          <p className="mt-1 text-sm text-muted">{t("githubKeys.description")}</p>
          {!ownAgents && <p className="mt-1 text-sm text-muted">{t("githubKeys.ownOnly")}</p>}
        </div>
        <Button icon={<Plus aria-hidden="true" className="size-4" />} onClick={() => setAdding(true)}>
          {t("githubKeys.add")}
        </Button>
      </div>
      {isPending ? (
        <Skeleton className="h-16" />
      ) : isError ? (
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      ) : data.keys.length === 0 ? (
        <p className="text-sm text-muted">{t("githubKeys.none")}</p>
      ) : (
        <ul className="border-y">
          {data.keys.map((key) => (
            <KeyRow key={key.id} githubKey={key} />
          ))}
        </ul>
      )}
      {adding && <AddKeyDialog onClose={() => setAdding(false)} />}
    </section>
  );
}

function KeyRow({ githubKey }: { githubKey: StudioGithubKey }) {
  const { t } = useTranslation(["studio", "common"]);
  const queryClient = useQueryClient();
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [checking, setChecking] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: studioGithubKeysQuery.queryKey });

  const check = async () => {
    setChecking(true);
    try {
      const result = await studioApi.checkGithubKey(githubKey.id);
      if (result.ok && result.repositories === 0) {
        // Often a token made for another owner: GitHub answers, with nothing to read.
        toast({
          title: t("githubKeys.noRepositories", { login: result.login ?? "?", owner: githubKey.owner }),
        });
      } else if (result.ok) {
        toast.success(
          result.repositories === null
            ? t("githubKeys.checked", { login: result.login ?? "?" })
            : t("githubKeys.checkedRepositories", {
                login: result.login ?? "?",
                count: result.repositories,
                owner: githubKey.owner,
              }),
        );
      } else {
        toast.error(result.message ?? t("githubKeys.checkFailed"));
      }
      await refresh();
    } catch (reason) {
      toast.error(errorMessage(reason, t));
    } finally {
      setChecking(false);
    }
  };

  const remove = async () => {
    await studioApi.removeGithubKey(githubKey.id);
    toast.success(t("githubKeys.removed", { owner: githubKey.owner }));
    await refresh();
  };

  const detail =
    githubKey.valid === false
      ? t("githubKeys.refused")
      : githubKey.checkedAt === null
        ? t("githubKeys.added", { date: new Date(githubKey.createdAt).toLocaleDateString() })
        : githubKey.expiresAt === null
          ? t("githubKeys.tokenOf", { login: githubKey.login ?? "?" })
          : t("githubKeys.tokenOfUntil", {
              login: githubKey.login ?? "?",
              date: new Date(githubKey.expiresAt).toLocaleDateString(),
            });

  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b py-2.5 last:border-b-0">
      <KeyRound aria-hidden="true" className="size-4 text-muted" />
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate font-mono text-sm">{githubKey.owner}</span>
        <span className="truncate text-xs text-muted">{detail}</span>
      </span>
      <span className="flex items-center gap-1">
        <Button size="sm" variant="ghost" pending={checking} onClick={check}>
          {t("githubKeys.check")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>
          {t("githubKeys.replace")}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t("githubKeys.remove", { owner: githubKey.owner })}
          onClick={() => setRemoving(true)}
        >
          <Trash2 aria-hidden="true" className="size-4" />
        </Button>
      </span>
      {replacing && <ReplaceKeyDialog githubKey={githubKey} onClose={() => setReplacing(false)} />}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t("githubKeys.removeTitle", { owner: githubKey.owner })}
        description={t("githubKeys.removeDescription")}
        confirmLabel={t("githubKeys.removeConfirm")}
        onConfirm={remove}
      />
    </li>
  );
}

function AddKeyDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["studio", "common"]);
  const queryClient = useQueryClient();
  const form = useForm({
    t,
    initialValues: { owner: "", token: "" },
    validate: (values) => ({
      ...(values.owner.trim() === "" ? { owner: t("githubKeys.ownerRequired") } : {}),
      ...(values.token.trim() === "" ? { token: t("githubKeys.tokenRequired") } : {}),
    }),
    onSubmit: async (values) => {
      const added = await studioApi.addGithubKey({ owner: values.owner.trim(), token: values.token.trim() });
      await queryClient.invalidateQueries({ queryKey: studioGithubKeysQuery.queryKey });
      toast.success(t("githubKeys.addedDone", { owner: added.owner }));
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !form.pending && onClose()}
      size="sm"
      title={t("githubKeys.addTitle")}
      description={t("githubKeys.addDescription")}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={form.pending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("githubKeys.addSubmit")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("githubKeys.owner")} hint={t("githubKeys.ownerHint")} error={form.errors.owner}>
          <Input
            {...form.field("owner")}
            mono
            placeholder="voidagency"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label={t("githubKeys.token")} hint={t("githubKeys.tokenHint")} error={form.errors.token}>
          <Input {...form.field("token")} mono type="password" autoComplete="off" spellCheck={false} />
        </Field>
      </div>
    </Dialog>
  );
}

function ReplaceKeyDialog({ githubKey, onClose }: { githubKey: StudioGithubKey; onClose: () => void }) {
  const { t } = useTranslation(["studio", "common"]);
  const queryClient = useQueryClient();
  const form = useForm({
    t,
    initialValues: { token: "" },
    validate: (values) => (values.token.trim() === "" ? { token: t("githubKeys.tokenRequired") } : {}),
    onSubmit: async (values) => {
      await studioApi.replaceGithubKey(githubKey.id, values.token.trim());
      await queryClient.invalidateQueries({ queryKey: studioGithubKeysQuery.queryKey });
      toast.success(t("githubKeys.replacedDone", { owner: githubKey.owner }));
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !form.pending && onClose()}
      size="sm"
      title={t("githubKeys.replaceTitle", { owner: githubKey.owner })}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={form.pending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("githubKeys.replaceSubmit")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("githubKeys.token")} hint={t("githubKeys.tokenHint")} error={form.errors.token}>
          <Input {...form.field("token")} mono type="password" autoComplete="off" spellCheck={false} />
        </Field>
      </div>
    </Dialog>
  );
}
