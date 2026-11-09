import { saveSourceRequest } from "@opsifier/contract";
import { CircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../../lib/cn";
import { schemaErrors, useForm } from "../../../../lib/forms";
import { Button, CodeEditor, FormBanner } from "../../../../ui";
import { type SourceSectionProps, useSaveSource } from "./SourceFormShared";

/** A Dockerfile written in the panel. It is built as is, with nothing else in its context. */
export function DockerfileSourceForm({ project, service, source, onSaved, submitLabel }: SourceSectionProps) {
  const { t } = useTranslation("service-source");
  const { save } = useSaveSource({ project, service, onSaved });
  const form = useForm({
    t,
    initialValues: { dockerfile: source?.type === "dockerfile" ? source.dockerfile : "" },
    validate: (values) =>
      schemaErrors<"dockerfile">(
        saveSourceRequest,
        { type: "dockerfile", ...values },
        { dockerfile: t("errors.dockerfileRequired") },
      ),
    onSubmit: async (values) => {
      await save({ type: "dockerfile", dockerfile: values.dockerfile });
    },
  });

  return (
    <form onSubmit={form.handleSubmit} noValidate className="grid max-w-[900px] gap-4">
      {form.banner && <FormBanner>{form.banner}</FormBanner>}
      <div className="grid gap-1.5">
        <p className="text-sm font-medium">{t("dockerfile.label")}</p>
        <CodeEditor
          value={form.values.dockerfile}
          onChange={(value) => form.set("dockerfile", value)}
          label={t("dockerfile.label")}
          language="plain"
          invalid={form.errors.dockerfile !== undefined}
        />
        <p
          className={cn(
            "flex items-start gap-1.5 text-xs",
            form.errors.dockerfile ? "text-bad" : "text-muted",
          )}
        >
          {form.errors.dockerfile && <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />}
          <span>{form.errors.dockerfile ?? t("dockerfile.hint")}</span>
        </p>
      </div>
      <div>
        <Button type="submit" variant="primary" pending={form.pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
