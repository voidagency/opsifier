import { type ServiceSource, saveSourceRequest } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../../lib/cn";
import { schemaErrors, useForm } from "../../../../lib/forms";
import { Button, Field, FormBanner, Input } from "../../../../ui";
import { githubBranchesQuery, githubRepositoriesQuery } from "./api";
import { Combobox } from "./Combobox";
import {
  EmbeddedBuild,
  type SourceSectionProps,
  useBuildDraft,
  useSaveSource,
  usesSharedSave,
} from "./SourceFormShared";

type GithubSource = Extract<ServiceSource, { type: "github" }>;

const SEARCH_DELAY_MS = 200;

function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** With a token the repository and branch are searched for. Without one they are typed by hand. */
export function GithubSourceForm({
  project,
  service,
  source,
  build,
  onSaved,
  submitLabel,
  githubConfigured,
}: SourceSectionProps & { githubConfigured: boolean }) {
  const { t } = useTranslation("service-source");
  const saved: GithubSource | null = source?.type === "github" ? source : null;
  const { save } = useSaveSource({ project, service, onSaved });
  const shared = usesSharedSave(source, "github");
  const draft = useBuildDraft(build);

  const form = useForm({
    t,
    initialValues: { repository: saved?.repository ?? "", ref: saved?.ref ?? "", path: saved?.path ?? "/" },
    validate: (values) =>
      schemaErrors<"repository" | "ref" | "path">(
        saveSourceRequest,
        { type: "github", ...values },
        {
          repository: t("errors.repositoryInvalid"),
          ref: values.ref.trim() === "" ? t("errors.refRequired") : t("errors.refInvalid"),
          path: values.path.trim() === "" ? t("errors.pathRequired") : t("errors.pathInvalid"),
        },
      ),
    onSubmit: async (values) => {
      const buildConfig = shared ? draft.validate() : undefined;
      if (shared && buildConfig === undefined) {
        return;
      }
      await save({
        type: "github",
        repository: values.repository,
        ref: values.ref,
        path: values.path,
        ...(shared && buildConfig !== undefined ? { build: buildConfig } : {}),
      });
    },
  });

  const { repository } = form.values;
  const search = useDebounced(repository.trim(), SEARCH_DELAY_MS);
  const repositories = useQuery({ ...githubRepositoriesQuery(search), enabled: githubConfigured });
  const fullName = /^[^/\s]+\/[^/\s]+$/.test(repository.trim()) ? repository.trim() : null;
  const branches = useQuery({
    ...githubBranchesQuery(fullName ?? ""),
    enabled: githubConfigured && fullName !== null,
  });

  return (
    <form onSubmit={form.handleSubmit} noValidate className="grid max-w-[520px] gap-4">
      {!githubConfigured && (
        <FormBanner tone="warning">
          {t("github.tokenWarning")}{" "}
          <Link to="/settings/server/github" className="underline underline-offset-2">
            {t("github.tokenLink")}
          </Link>
        </FormBanner>
      )}
      {form.banner && <FormBanner>{form.banner}</FormBanner>}
      <Field label={t("github.repository")} hint={t("github.repositoryHint")} error={form.errors.repository}>
        {githubConfigured ? (
          <Combobox
            name="repository"
            value={repository}
            onValueChange={(value) => form.set("repository", value)}
            options={(repositories.data?.items ?? []).map((item) => ({
              value: item.fullName,
              note: item.private ? t("github.private") : undefined,
            }))}
            filter={false}
            placeholder={t("github.repositoryPlaceholder")}
            emptyText={repositories.isPending ? t("github.searching") : t("github.noRepositories")}
          />
        ) : (
          <Input
            {...form.field("repository")}
            mono
            placeholder={t("github.repositoryPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </Field>
      <div className="-mt-1 flex items-baseline gap-1.5 border-l-2 border-rule py-0.5 pl-2.5 font-mono text-sm">
        <span className="text-muted">github.com /</span>
        <span className={cn("min-w-0 truncate", repository.trim() === "" && "text-muted")}>
          {repository.trim() || t("github.previewEmpty")}
        </span>
      </div>
      <Field label={t("branch")} hint={t("branchHint")} error={form.errors.ref}>
        {githubConfigured && fullName !== null ? (
          <Combobox
            name="ref"
            value={form.values.ref}
            onValueChange={(value) => form.set("ref", value)}
            options={(branches.data?.items ?? []).map((item) => item.name)}
            placeholder="main"
            emptyText={branches.isPending ? t("github.searching") : t("github.noBranches")}
          />
        ) : (
          <Input {...form.field("ref")} mono placeholder="main" autoComplete="off" spellCheck={false} />
        )}
      </Field>
      <Field label={t("path")} hint={t("pathHint")} error={form.errors.path}>
        <Input {...form.field("path")} mono placeholder="/" autoComplete="off" spellCheck={false} />
      </Field>
      {shared && <EmbeddedBuild draft={draft} />}
      <div>
        <Button type="submit" variant="primary" pending={form.pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
