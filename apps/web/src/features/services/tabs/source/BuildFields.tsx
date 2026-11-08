import {
  type BuildConfig,
  type BuildType,
  buildConfig,
  buildpacksBuilders,
  defaultBuildpacksBuilder,
  defaultNixpacksVersion,
  defaultRailpackVersion,
  nixpacksVersions,
  railpackVersions,
} from "@opsifier/contract";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Field, Input } from "../../../../ui";
import { Combobox } from "./Combobox";

interface BuildValues {
  type: BuildType | null;
  file: string;
  builder: string;
  nixpacksVersion: string;
  railpackVersion: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  nixPackages: string;
  aptPackages: string;
  misePackages: string;
  buildAptPackages: string;
  deployAptPackages: string;
}

type BuildField = keyof Omit<BuildValues, "type">;

function valuesFrom(saved: BuildConfig | null): BuildValues {
  return {
    type: saved?.type ?? null,
    file: saved?.type === "dockerfile" ? saved.file : "",
    builder: saved?.type === "buildpacks" ? saved.builder : defaultBuildpacksBuilder,
    nixpacksVersion: saved?.type === "nixpacks" ? saved.version : defaultNixpacksVersion,
    railpackVersion: saved?.type === "railpack" ? saved.version : defaultRailpackVersion,
    installCommand: saved?.type === "nixpacks" || saved?.type === "railpack" ? saved.installCommand : "",
    buildCommand: saved?.type === "nixpacks" || saved?.type === "railpack" ? saved.buildCommand : "",
    startCommand: saved?.type === "nixpacks" || saved?.type === "railpack" ? saved.startCommand : "",
    nixPackages: saved?.type === "nixpacks" ? saved.nixPackages : "",
    aptPackages: saved?.type === "nixpacks" ? saved.aptPackages : "",
    misePackages: saved?.type === "railpack" ? saved.misePackages : "",
    buildAptPackages: saved?.type === "railpack" ? saved.buildAptPackages : "",
    deployAptPackages: saved?.type === "railpack" ? saved.deployAptPackages : "",
  };
}

/** What the form holds for the builder chosen, in the shape the API takes. */
function toConfig(values: BuildValues): unknown {
  switch (values.type) {
    case "dockerfile":
      return { type: "dockerfile", file: values.file };
    case "buildpacks":
      return { type: "buildpacks", builder: values.builder };
    case "nixpacks":
      return {
        type: "nixpacks",
        version: values.nixpacksVersion,
        installCommand: values.installCommand,
        buildCommand: values.buildCommand,
        startCommand: values.startCommand,
        nixPackages: values.nixPackages,
        aptPackages: values.aptPackages,
      };
    case "railpack":
      return {
        type: "railpack",
        version: values.railpackVersion,
        installCommand: values.installCommand,
        buildCommand: values.buildCommand,
        startCommand: values.startCommand,
        misePackages: values.misePackages,
        buildAptPackages: values.buildAptPackages,
        deployAptPackages: values.deployAptPackages,
      };
    default:
      return null;
  }
}

/** The contract's name for a field, mapped to the form's. */
const FIELD_BY_CONTRACT: Record<string, BuildField> = {
  file: "file",
  builder: "builder",
  installCommand: "installCommand",
  buildCommand: "buildCommand",
  startCommand: "startCommand",
  nixPackages: "nixPackages",
  aptPackages: "aptPackages",
  misePackages: "misePackages",
  buildAptPackages: "buildAptPackages",
  deployAptPackages: "deployAptPackages",
};

export interface BuildDraft {
  values: BuildValues;
  errors: Partial<Record<BuildField, string>>;
  setType: (type: BuildType) => void;
  set: (name: BuildField, value: string) => void;
  /** The builder settings, null when none is chosen, or undefined if something needs fixing. */
  validate: () => BuildConfig | null | undefined;
  reset: (saved: BuildConfig | null) => void;
}

/** Holds the build fields, for a form that saves them alone and one that saves them with the source. */
export function useBuildDraft(saved: BuildConfig | null): BuildDraft {
  const { t } = useTranslation("service-source");
  const [values, setValues] = useState(() => valuesFrom(saved));
  const [errors, setErrors] = useState<BuildDraft["errors"]>({});

  const setType = useCallback((type: BuildType) => {
    setValues((current) => ({ ...current, type }));
    setErrors({});
  }, []);

  const set = useCallback((name: BuildField, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => {
      if (current[name] === undefined) {
        return current;
      }
      const { [name]: _cleared, ...rest } = current;
      return rest;
    });
  }, []);

  const validate = () => {
    if (values.type === null) {
      setErrors({});
      return null;
    }
    const parsed = buildConfig.safeParse(toConfig(values));
    if (parsed.success) {
      setErrors({});
      return parsed.data;
    }
    const next: BuildDraft["errors"] = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]);
      const message = t(`errors.build.${key}`, { defaultValue: issue.message });
      if (key === "version") {
        next[values.type === "nixpacks" ? "nixpacksVersion" : "railpackVersion"] ??= message;
      } else {
        const field = FIELD_BY_CONTRACT[key];
        if (field !== undefined) {
          next[field] ??= message;
        }
      }
    }
    setErrors(next);
    return undefined;
  };

  const reset = useCallback((next: BuildConfig | null) => {
    setValues(valuesFrom(next));
    setErrors({});
  }, []);

  return { values, errors, setType, set, validate, reset };
}

function TextField({
  draft,
  name,
  label,
  hint,
  placeholder,
  optional = true,
}: {
  draft: BuildDraft;
  name: BuildField;
  label: ReactNode;
  hint?: ReactNode;
  placeholder?: string;
  optional?: boolean;
}) {
  return (
    <Field label={label} hint={hint} optional={optional} error={draft.errors[name]}>
      <Input
        mono
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={draft.values[name]}
        onChange={(event) => draft.set(name, event.currentTarget.value)}
      />
    </Field>
  );
}

const BUILDERS: readonly BuildType[] = ["dockerfile", "buildpacks", "nixpacks", "railpack"];

/** The choice of builder and the fields of the one chosen. */
export function BuildFields({ draft }: { draft: BuildDraft }) {
  const { t } = useTranslation("service-source");
  const { type } = draft.values;

  const nixpacksOptions = useMemo(() => [...nixpacksVersions], []);
  const railpackOptions = useMemo(() => [...railpackVersions], []);

  return (
    <>
      <fieldset className="relative m-0 grid gap-1 border-0 p-0">
        <legend className="sr-only">{t("build.title")}</legend>
        {BUILDERS.map((builder) => (
          <label
            key={builder}
            className="flex cursor-pointer items-start gap-2.5 rounded-sm px-2 py-1.5 hover:bg-wash"
          >
            <input
              type="radio"
              name="builder"
              className="mt-[3px] size-3.5 shrink-0 accent-accent"
              checked={type === builder}
              onChange={() => draft.setType(builder)}
            />
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">{t(`build.types.${builder}`)}</span>
              <span className="text-xs text-muted">{t(`build.descriptions.${builder}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {type === "dockerfile" && (
        <TextField
          draft={draft}
          name="file"
          label={t("build.file")}
          hint={t("build.fileHint")}
          placeholder="Dockerfile"
        />
      )}

      {type === "buildpacks" && (
        <Field label={t("build.builder")} hint={t("build.builderHint")} error={draft.errors.builder}>
          <Combobox
            value={draft.values.builder}
            onValueChange={(value) => draft.set("builder", value)}
            options={buildpacksBuilders}
          />
        </Field>
      )}

      {type === "nixpacks" && (
        <>
          <Field label={t("build.version")} error={draft.errors.nixpacksVersion}>
            <Combobox
              value={draft.values.nixpacksVersion}
              onValueChange={(value) => draft.set("nixpacksVersion", value)}
              options={nixpacksOptions}
            />
          </Field>
          <TextField
            draft={draft}
            name="installCommand"
            label={t("build.installCommand")}
            hint={t("build.commandHint")}
            placeholder="npm ci"
          />
          <TextField
            draft={draft}
            name="buildCommand"
            label={t("build.buildCommand")}
            placeholder="npm run build"
          />
          <TextField
            draft={draft}
            name="startCommand"
            label={t("build.startCommand")}
            placeholder="npm start"
          />
          <TextField
            draft={draft}
            name="nixPackages"
            label={t("build.nixPackages")}
            hint={t("build.packagesHint")}
            placeholder="ffmpeg imagemagick"
          />
          <TextField draft={draft} name="aptPackages" label={t("build.aptPackages")} placeholder="curl" />
        </>
      )}

      {type === "railpack" && (
        <>
          <Field label={t("build.version")} error={draft.errors.railpackVersion}>
            <Combobox
              value={draft.values.railpackVersion}
              onValueChange={(value) => draft.set("railpackVersion", value)}
              options={railpackOptions}
            />
          </Field>
          <TextField
            draft={draft}
            name="buildCommand"
            label={t("build.buildCommand")}
            hint={t("build.commandHint")}
            placeholder="npm run build"
          />
          <TextField
            draft={draft}
            name="installCommand"
            label={t("build.installCommand")}
            placeholder="npm ci"
          />
          <TextField
            draft={draft}
            name="startCommand"
            label={t("build.startCommand")}
            placeholder="npm start"
          />
          <TextField
            draft={draft}
            name="misePackages"
            label={t("build.misePackages")}
            hint={t("build.misePackagesHint")}
            placeholder="node@22 python"
          />
          <TextField
            draft={draft}
            name="buildAptPackages"
            label={t("build.buildAptPackages")}
            hint={t("build.packagesHint")}
            placeholder="curl"
          />
          <TextField
            draft={draft}
            name="deployAptPackages"
            label={t("build.deployAptPackages")}
            placeholder="ca-certificates"
          />
        </>
      )}
    </>
  );
}
