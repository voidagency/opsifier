import type { BuildConfig } from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../../../lib/forms";
import { Button, FormBanner, toast } from "../../../../ui";
import { sourceApi, sourceSettingsKey } from "./api";
import { BuildFields, useBuildDraft } from "./BuildFields";

/** How the code becomes an image, once the source is saved: its own form, with its own Save. */
export function BuildSection({
  project,
  service,
  build,
}: {
  project: string;
  service: string;
  build: BuildConfig | null;
}) {
  const { t } = useTranslation(["service-source", "common"]);
  const queryClient = useQueryClient();
  const draft = useBuildDraft(build);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const apply = async (config: BuildConfig | null, title: string, hint: string) => {
    setSaving(true);
    setFailure(null);
    try {
      await sourceApi.saveBuild(project, service, config);
      await queryClient.invalidateQueries({ queryKey: sourceSettingsKey(project, service) });
      toast.success(title, hint);
    } catch (cause) {
      setFailure(errorMessage(cause, t));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    const config = draft.validate();
    if (config !== undefined) {
      await apply(config, t("build.saved"), t("build.savedHint"));
    }
  };

  const skip = async () => {
    await apply(null, t("build.skipped"), t("build.skippedHint"));
    draft.reset(null);
  };

  return (
    <section className="grid gap-3 border-t pt-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-md font-medium">{t("build.title")}</h3>
          <p className="mt-0.5 text-sm text-muted">{t("build.description")}</p>
        </div>
        <Button size="sm" variant="ghost" disabled={saving} onClick={skip}>
          {t("build.skip")}
        </Button>
      </div>
      {failure !== null && <FormBanner>{failure}</FormBanner>}
      <BuildFields draft={draft} />
      {draft.values.type !== null && (
        <div>
          <Button variant="primary" pending={saving} onClick={save}>
            {t("build.submit")}
          </Button>
        </div>
      )}
    </section>
  );
}
