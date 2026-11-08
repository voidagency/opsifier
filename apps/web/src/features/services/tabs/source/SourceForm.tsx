import { isBuildableSourceType, type ServiceSource, type ServiceSourceType } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "../../../../ui";
import { AutoDeploySection } from "./AutoDeploySection";
import { sourceSettingsQuery } from "./api";
import { BuildSection } from "./BuildSection";
import { DockerfileSourceForm } from "./DockerfileSourceForm";
import { GithubSourceForm } from "./GithubSourceForm";
import { GitSourceForm } from "./GitSourceForm";
import { ImageSourceForm } from "./ImageSourceForm";
import { UploadSourceForm } from "./UploadSourceForm";

const SOURCE_TABS: readonly ServiceSourceType[] = ["image", "github", "git", "dockerfile", "upload"];

interface SourceFormProps {
  project: string;
  service: string;
  source: ServiceSource | null;
  /** Runs after the source is saved. */
  onSaved?: (source: ServiceSource) => void | Promise<void>;
  submitLabel: string;
}

/** The source of a service, one tab per kind. Once saved, its Build settings get their own form. */
export function SourceForm({ project, service, source, onSaved, submitLabel }: SourceFormProps) {
  const { t } = useTranslation("service-source");
  const [tab, setTab] = useState<ServiceSourceType>(source?.type ?? "image");
  // The forms render without this, so a slow or failed request never hides what is already known.
  const { data: settings, isPending: settingsPending } = useQuery(sourceSettingsQuery(project, service));
  const build = settings?.build ?? null;
  const githubConfigured = settings?.githubConfigured ?? false;
  const section = { project, service, source, build, onSaved, submitLabel };
  const showBuildSection = source !== null && source.type === tab && isBuildableSourceType(tab);

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as ServiceSourceType)} className="grid gap-5">
      <TabsList aria-label={t("tabs.label")} className="overflow-x-auto [scrollbar-width:none]">
        {SOURCE_TABS.map((type) => (
          <TabsTrigger key={type} value={type} className="shrink-0">
            {t(`tabs.${type}`)}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="image">
        <ImageSourceForm {...section} autoFocus={source === null} />
      </TabsContent>
      <TabsContent value="github">
        <GithubSourceForm {...section} githubConfigured={githubConfigured} />
      </TabsContent>
      <TabsContent value="git">
        <GitSourceForm {...section} />
      </TabsContent>
      <TabsContent value="dockerfile">
        <DockerfileSourceForm {...section} />
      </TabsContent>
      <TabsContent value="upload">
        <UploadSourceForm {...section} />
      </TabsContent>
      {showBuildSection &&
        (settingsPending ? (
          <Skeleton className="h-24 max-w-[520px]" />
        ) : (
          <div className="max-w-[520px]">
            <BuildSection key={JSON.stringify(build)} project={project} service={service} build={build} />
          </div>
        ))}
      {source?.type === "github" && tab === "github" && (
        <div className="max-w-[520px]">
          <AutoDeploySection
            project={project}
            service={service}
            source={source}
            githubConfigured={githubConfigured}
          />
        </div>
      )}
    </Tabs>
  );
}
