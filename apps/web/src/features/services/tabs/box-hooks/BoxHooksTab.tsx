import type { BoxHooks } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../../../lib/forms";
import { Button, CodeEditor, ErrorState, FormBanner, SectionIntro, Skeleton, toast } from "../../../../ui";
import { boxApi, boxQuery } from "../../../box/api";
import { serviceKey, useServiceParams } from "../../api";

function HooksForm({ initial, project, service }: { initial: BoxHooks; project: string; service: string }) {
  const { t } = useTranslation(["service-box-hooks", "common"]);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setBanner(null);
    try {
      await boxApi.saveHooks(project, service, draft);
      await queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
      toast.success(t("saved"));
    } catch (error) {
      setBanner(errorMessage(error, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6">
      <section className="grid gap-2">
        <SectionIntro pictogram="dockerfile" title={t("build.title")} description={t("build.description")} />
        <CodeEditor
          label={t("build.title")}
          language="plain"
          value={draft.build}
          onChange={(build) => setDraft((current) => ({ ...current, build }))}
          className="min-h-[200px]"
        />
      </section>
      <section className="grid gap-2">
        <SectionIntro pictogram="deployment" title={t("start.title")} description={t("start.description")} />
        <CodeEditor
          label={t("start.title")}
          language="plain"
          value={draft.start}
          onChange={(start) => setDraft((current) => ({ ...current, start }))}
          className="min-h-[200px]"
        />
      </section>
      <p className="text-sm text-muted">{t("failure")}</p>
      {banner !== null && <FormBanner>{banner}</FormBanner>}
      <div>
        <Button variant="primary" pending={saving} onClick={save}>
          {t("save")}
        </Button>
      </div>
    </div>
  );
}

/** Two short scripts: one that shapes the image, one that readies the workspace. */
export function BoxHooksTab() {
  const { t } = useTranslation(["service-box-hooks", "common"]);
  const { project, service } = useServiceParams();
  const query = useQuery(boxQuery(project, service));

  if (query.isPending) {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="px-4 py-6 md:px-6 lg:px-8">
        <ErrorState message={errorMessage(query.error, t)} onRetry={() => query.refetch()} />
      </div>
    );
  }
  return (
    <div className="max-w-[1130px] px-4 py-6 md:px-6 lg:px-8">
      <HooksForm
        key={`${query.data.hooks.build}:${query.data.hooks.start}`}
        initial={query.data.hooks}
        project={project}
        service={service}
      />
    </div>
  );
}
