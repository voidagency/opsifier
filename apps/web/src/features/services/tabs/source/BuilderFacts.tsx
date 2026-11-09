import { type BuildConfig, builderLanguages, packVersion } from "@opsifier/contract";
import type { TFunction } from "i18next";
import { Info } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

/** Which release of the builder a build would use, as far as this form can say. */
function versionText(config: BuildConfig, t: TFunction<"service-source">): string {
  switch (config.type) {
    case "dockerfile":
      return t("build.facts.versionDockerfile");
    case "buildpacks":
      return t("build.facts.versionBuildpacks", { pack: packVersion, builder: config.builder });
    case "nixpacks":
    case "railpack":
      return config.version;
  }
}

function languagesText(config: BuildConfig, t: TFunction<"service-source">): string {
  const languages = builderLanguages(config);
  if (languages !== null) {
    return languages.join(", ");
  }
  return config.type === "dockerfile" ? t("build.facts.anyLanguage") : t("build.facts.unknownLanguages");
}

/** What the chosen builder is, what it can build, what can be changed and how it fails, on request. */
export function BuilderFacts({ config }: { config: BuildConfig }) {
  const { t } = useTranslation("service-source");
  const [open, setOpen] = useState(false);
  const id = useId();

  const rows = [
    { label: t("build.facts.version"), value: versionText(config, t) },
    { label: t("build.facts.languages"), value: languagesText(config, t) },
    { label: t("build.facts.overrides"), value: t(`build.facts.overridesBy.${config.type}`) },
    { label: t("build.facts.fails"), value: t(`build.facts.failsBy.${config.type}`) },
  ];

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-sm text-muted hover:text-ink aria-expanded:text-ink"
      >
        <Info aria-hidden="true" className="size-3.5" />
        {t("build.facts.toggle")}
      </button>
      <dl id={id} hidden={!open} className="mt-1.5 grid gap-1.5 text-sm">
        {rows.map(({ label, value }) => (
          <div key={label} className="grid grid-cols-[minmax(0,130px)_minmax(0,1fr)] gap-2">
            <dt className="text-muted">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
