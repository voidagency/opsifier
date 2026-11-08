import type { BuildConfig, SaveSourceRequest, ServiceDetail, ServiceSource } from "@opsifier/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "../../../../ui";
import { serviceKey, servicesApi } from "../../api";
import { type BuildDraft, BuildFields, useBuildDraft } from "./BuildFields";

export interface SourceSectionProps {
  project: string;
  service: string;
  source: ServiceSource | null;
  /** The saved build settings, when the source already has any. */
  build: BuildConfig | null;
  /** Runs after the source is saved. */
  onSaved?: (source: ServiceSource) => void | Promise<void>;
  submitLabel: string;
}

/** Saves a source and refreshes everything that shows it. */
export function useSaveSource({
  project,
  service,
  onSaved,
}: Pick<SourceSectionProps, "project" | "service" | "onSaved">) {
  const { t } = useTranslation("service-source");
  const queryClient = useQueryClient();

  const finish = async (saved: ServiceSource) => {
    queryClient.setQueryData<ServiceDetail>(serviceKey(project, service), (current) =>
      current === undefined ? current : { ...current, source: saved },
    );
    await queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
    toast.success(t("saved"), t("savedHint"));
    await onSaved?.(saved);
  };

  return {
    save: async (body: SaveSourceRequest) => {
      const saved = await servicesApi.saveSource(project, service, body);
      await finish(saved);
      return saved;
    },
    finish,
  };
}

/**
 * True when the build settings go with this form's own Save: before the source exists, or while
 * switching to a new kind of source. Otherwise the Build section below saves them separately.
 */
export function usesSharedSave(source: ServiceSource | null, type: ServiceSource["type"]): boolean {
  return source?.type !== type;
}

/** The Build section as part of a source form, sharing its Save button. */
export function EmbeddedBuild({ draft }: { draft: BuildDraft }) {
  const { t } = useTranslation("service-source");
  return (
    <section className="grid gap-3 border-t pt-4">
      <div>
        <h3 className="text-md font-medium">{t("build.title")}</h3>
        <p className="mt-0.5 text-sm text-muted">{t("build.description")}</p>
      </div>
      <BuildFields draft={draft} />
    </section>
  );
}

export { useBuildDraft };
