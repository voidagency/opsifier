import {
  archiveExtensions,
  isSupportedArchiveName,
  MAX_UPLOAD_BYTES,
  type ServiceSource,
  saveSourceRequest,
} from "@opsifier/contract";
import { UploadCloud } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../../lib/cn";
import { formatBytes } from "../../../../lib/format";
import { schemaErrors, useForm } from "../../../../lib/forms";
import { Button, Field, FormBanner, Input } from "../../../../ui";
import { sourceApi } from "./api";
import {
  EmbeddedBuild,
  type SourceSectionProps,
  useBuildDraft,
  useSaveSource,
  usesSharedSave,
} from "./SourceFormShared";

const ACCEPT = archiveExtensions.join(",");

function fileProblem(file: File, t: ReturnType<typeof useTranslation>["t"]): string | null {
  if (!isSupportedArchiveName(file.name)) {
    return t("errors.fileType");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return t("errors.fileTooLarge", { limit: formatBytes(MAX_UPLOAD_BYTES) });
  }
  return null;
}

/** An archive of the code, unpacked again at every deploy. */
export function UploadSourceForm({
  project,
  service,
  source,
  build,
  onSaved,
  submitLabel,
}: SourceSectionProps) {
  const { t } = useTranslation(["service-source", "common"]);
  const saved = source?.type === "upload" ? source : null;
  const { save, finish } = useSaveSource({ project, service, onSaved });
  const shared = usesSharedSave(source, "upload");
  const draft = useBuildDraft(build);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const form = useForm({
    t,
    initialValues: { path: saved?.path ?? "/" },
    validate: (values) => {
      const problems = schemaErrors<"path">(
        saveSourceRequest,
        { type: "upload", ...values },
        { path: values.path.trim() === "" ? t("errors.pathRequired") : t("errors.pathInvalid") },
      );
      if (file === null && saved === null) {
        setFileError(t("errors.fileRequired"));
        return { ...problems, path: problems.path ?? " " };
      }
      return problems;
    },
    onSubmit: async (values) => {
      const buildConfig = shared ? draft.validate() : undefined;
      if (shared && buildConfig === undefined) {
        return;
      }
      if (file === null) {
        await save({ type: "upload", path: values.path });
        return;
      }
      setProgress(0);
      try {
        const uploaded: ServiceSource = await sourceApi.upload(
          project,
          service,
          file,
          values.path,
          setProgress,
        );
        if (shared && buildConfig !== undefined && buildConfig !== null) {
          await sourceApi.saveBuild(project, service, buildConfig);
        }
        setFile(null);
        await finish(uploaded);
      } finally {
        setProgress(null);
      }
    },
  });

  const choose = (candidate: File | undefined) => {
    if (candidate === undefined) {
      return;
    }
    const problem = fileProblem(candidate, t);
    setFileError(problem);
    setFile(problem === null ? candidate : null);
  };

  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files[0]);
  };

  const percent = progress === null ? null : Math.round(progress * 100);

  return (
    <form onSubmit={form.handleSubmit} noValidate className="relative grid max-w-[520px] gap-4">
      {form.banner && <FormBanner>{form.banner}</FormBanner>}
      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "grid justify-items-center gap-1 rounded-sm border border-dashed border-off px-4 py-8 text-center hover:bg-wash",
          dragging && "border-accent bg-wash",
        )}
      >
        <UploadCloud aria-hidden="true" className="size-5 text-muted" />
        <span className="text-sm font-medium">{t("upload.drop")}</span>
        <span className="text-xs text-muted">
          {t("upload.formats", { limit: formatBytes(MAX_UPLOAD_BYTES) })}
        </span>
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-label={t("upload.choose")}
        onChange={(event) => {
          choose(event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }}
      />
      {fileError !== null && <FormBanner>{fileError}</FormBanner>}
      {file !== null && (
        <p className="flex items-baseline justify-between gap-3 text-sm">
          <span className="min-w-0 truncate font-mono">{file.name}</span>
          <span className="shrink-0 font-mono text-xs text-muted">{formatBytes(file.size)}</span>
        </p>
      )}
      {file === null && saved !== null && (
        <p className="flex items-baseline justify-between gap-3 text-sm">
          <span className="text-muted">{t("upload.current")}</span>
          <span className="min-w-0 truncate font-mono">{saved.fileName}</span>
          <span className="shrink-0 font-mono text-xs text-muted">{formatBytes(saved.sizeBytes)}</span>
        </p>
      )}
      {percent !== null && (
        <div>
          <div className="h-1.5 overflow-hidden rounded-sm bg-wash">
            <div
              className="h-full bg-accent transition-[width] duration-150 ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-muted">{t("upload.uploading", { percent })}</p>
        </div>
      )}
      <Field label={t("path")} hint={t("pathHint")} error={form.errors.path?.trim() || undefined}>
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
