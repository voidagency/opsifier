import { type ServiceSource, saveSourceRequest } from "@opsifier/contract";
import { useTranslation } from "react-i18next";
import { schemaErrors, useForm } from "../../../../lib/forms";
import { Button, Field, FormBanner, Input } from "../../../../ui";
import {
  EmbeddedBuild,
  type SourceSectionProps,
  useBuildDraft,
  useSaveSource,
  usesSharedSave,
} from "./SourceFormShared";
import { SshKeySection } from "./SshKeySection";

type GitSource = Extract<ServiceSource, { type: "git" }>;

/** Any Git host, over https or SSH. A private repository takes a deploy key, generated below the form. */
export function GitSourceForm({ project, service, source, build, onSaved, submitLabel }: SourceSectionProps) {
  const { t } = useTranslation("service-source");
  const saved = source?.type === "git" ? source : null;
  const { save } = useSaveSource({ project, service, onSaved });
  const shared = usesSharedSave(source, "git");
  const draft = useBuildDraft(build);

  const form = useForm({
    t,
    initialValues: { url: saved?.url ?? "", ref: saved?.ref ?? "", path: saved?.path ?? "/" },
    validate: (values) =>
      schemaErrors<"url" | "ref" | "path">(
        saveSourceRequest,
        { type: "git", ...values },
        {
          url: values.url.trim() === "" ? t("errors.urlRequired") : t("errors.urlInvalid"),
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
        type: "git",
        url: values.url,
        ref: values.ref,
        path: values.path,
        ...(shared && buildConfig !== undefined ? { build: buildConfig } : {}),
      });
    },
  });

  return (
    <div className="grid max-w-[650px] gap-6">
      <form onSubmit={form.handleSubmit} noValidate className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("git.url")} hint={t("git.urlHint")} error={form.errors.url}>
          <Input
            {...form.field("url")}
            mono
            placeholder="git@git.example.com:team/app.git"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label={t("branch")} hint={t("branchHint")} error={form.errors.ref}>
          <Input {...form.field("ref")} mono placeholder="main" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label={t("path")} hint={t("pathHint")} error={form.errors.path}>
          <Input {...form.field("path")} mono placeholder="/" autoComplete="off" spellCheck={false} />
        </Field>
        {shared && <EmbeddedBuild draft={draft} />}
        {saved !== null && <p className="text-sm text-muted">{t("changeRevokes")}</p>}
        <div>
          <Button type="submit" variant="primary" pending={form.pending}>
            {submitLabel}
          </Button>
        </div>
      </form>
      <SshKeySection project={project} service={service} />
    </div>
  );
}

export type { GitSource };
