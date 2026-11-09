import type {
  ComposeDetail,
  ComposeIssue,
  ComposeSource,
  SaveComposeSourceRequest,
} from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../../lib/forms";
import {
  Button,
  Checkbox,
  CodeEditor,
  Dialog,
  ErrorState,
  Field,
  FormBanner,
  Input,
  Lamp,
  SectionIntro,
  Segmented,
  Skeleton,
  toast,
} from "../../ui";
import { useCurrentUser } from "../auth/session";
import { serviceKey, useServiceParams } from "../services/api";
import { SshKeySection } from "../services/tabs/source/SshKeySection";
import { composeApi, composeQuery } from "./api";

type Kind = ComposeSource["type"];

const issueLamp = { error: "failed", host: "degraded", warning: "unknown" } as const;

function IssueRow({ issue }: { issue: ComposeIssue }) {
  const { t } = useTranslation("compose");
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 border-b py-2 last:border-b-0">
      <Lamp
        state={issueLamp[issue.severity]}
        size="sm"
        label={t(`issues.severity.${issue.severity}`)}
        className="mt-1"
      />
      <div className="min-w-0 text-sm">
        <p>
          {issue.service !== null && <span className="mr-1.5 font-mono font-medium">{issue.service}</span>}
          {t(`issues.codes.${issue.code}`)}
        </p>
        {issue.detail !== null && <p className="truncate font-mono text-xs text-muted">{issue.detail}</p>}
      </div>
    </li>
  );
}

function IssuesDialog({
  detail,
  open,
  onOpenChange,
  onConfirm,
}: {
  detail: ComposeDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useTranslation(["compose", "common"]);
  const isAdmin = useCurrentUser()?.role === "admin";
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setChecked(false);
      setFailure(null);
    }
  }, [open]);

  const hostIssues = detail.issues.filter((issue) => issue.severity === "host");

  const confirm = async () => {
    setPending(true);
    setFailure(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (cause) {
      setFailure(errorMessage(cause, t));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t("issues.title")}
      footer={
        detail.acknowledgementRequired && isAdmin ? (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant="primary"
              disabledReason={checked ? undefined : t("issues.confirmFirst")}
              pending={pending}
              onClick={confirm}
            >
              {t("issues.confirm")}
            </Button>
          </>
        ) : (
          <Button onClick={() => onOpenChange(false)}>{t("common:actions.close")}</Button>
        )
      }
    >
      <div className="grid gap-4">
        {failure !== null && <FormBanner>{failure}</FormBanner>}
        {detail.parseError !== null && (
          <pre className="overflow-x-auto rounded-sm border bg-wash p-3 font-mono text-xs whitespace-pre-wrap">
            {detail.parseError}
          </pre>
        )}
        {detail.issues.length > 0 && (
          <ul className="border-y">
            {detail.issues.map((issue) => (
              <IssueRow key={`${issue.code}-${issue.service}-${issue.detail}`} issue={issue} />
            ))}
          </ul>
        )}
        {detail.acknowledgementRequired && hostIssues.length > 0 && (
          <div className="grid gap-2 rounded-sm border p-3">
            <p className="text-sm font-medium">{t("issues.hostTitle")}</p>
            <p className="text-sm text-muted">{t("issues.hostBody")}</p>
            {isAdmin ? (
              <Checkbox
                label={t("issues.confirmLabel")}
                checked={checked}
                onChange={(event) => setChecked(event.currentTarget.checked)}
              />
            ) : (
              <p className="text-sm text-muted">{t("issues.adminOnly")}</p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** The warning band above the editor: visible problems first, with the detail one click away. */
function IssuesBanner({ detail, onView }: { detail: ComposeDetail; onView: () => void }) {
  const { t } = useTranslation("compose");
  if (detail.parseError === null && detail.issues.length === 0) {
    return null;
  }
  const errors = detail.parseError !== null || detail.issues.some((issue) => issue.severity === "error");
  const host = detail.issues.some((issue) => issue.severity === "host");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <FormBanner
        tone={errors ? "error" : "warning"}
        title={
          errors
            ? t("issues.bannerError")
            : host
              ? detail.acknowledged
                ? t("issues.bannerHostConfirmed")
                : t("issues.bannerHost")
              : t("issues.banner", { count: detail.issues.length })
        }
        className="min-w-0 flex-1"
      />
      <Button onClick={onView}>{t("issues.view")}</Button>
    </div>
  );
}

function initialFrom(source: ComposeSource | null): {
  kind: Kind;
  content: string;
  url: string;
  ref: string;
  path: string;
  file: string;
} {
  if (source?.type === "git") {
    return {
      kind: "git",
      content: "",
      url: source.url,
      ref: source.ref,
      path: source.path,
      file: source.file,
    };
  }
  return {
    kind: "inline",
    content: source?.type === "inline" ? source.content : "",
    url: "",
    ref: "",
    path: "/",
    file: "docker-compose.yml",
  };
}

function SourceForm({
  project,
  service,
  detail,
}: {
  project: string;
  service: string;
  detail: ComposeDetail;
}) {
  const { t } = useTranslation(["compose", "common"]);
  const queryClient = useQueryClient();
  const [values, setValues] = useState(() => initialFrom(detail.source));
  const [pending, setPending] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [viewing, setViewing] = useState(false);

  const set = (name: keyof typeof values, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => {
      const { [name]: _cleared, ...rest } = current;
      return rest;
    });
  };

  const save = async () => {
    setPending(true);
    setBanner(null);
    setErrors({});
    const body: SaveComposeSourceRequest =
      values.kind === "inline"
        ? { type: "inline", content: values.content }
        : { type: "git", url: values.url, ref: values.ref, path: values.path, file: values.file };
    try {
      const updated = await composeApi.saveSource(project, service, body);
      queryClient.setQueryData(composeQuery(project, service).queryKey, updated);
      await queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
      toast.success(t("source.saved"), t("source.savedHint"));
    } catch (cause) {
      const fields = (cause as { fields?: Record<string, string> }).fields ?? {};
      setErrors(fields);
      setBanner(errorMessage(cause, t));
    } finally {
      setPending(false);
    }
  };

  const confirm = async () => {
    const updated = await composeApi.acknowledge(project, service, detail.content ?? "");
    queryClient.setQueryData(composeQuery(project, service).queryKey, updated);
    await queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
    toast.success(t("issues.confirmed"));
  };

  return (
    <div className="grid gap-4">
      <IssuesBanner detail={detail} onView={() => setViewing(true)} />
      <IssuesDialog detail={detail} open={viewing} onOpenChange={setViewing} onConfirm={confirm} />
      {banner !== null && <FormBanner>{banner}</FormBanner>}
      <Segmented
        label={t("source.kind")}
        value={values.kind}
        onChange={(kind: Kind) => setValues((current) => ({ ...current, kind }))}
        options={[
          { value: "inline", label: t("source.inline") },
          { value: "git", label: t("source.git") },
        ]}
      />
      {values.kind === "inline" ? (
        <CodeEditor
          value={values.content}
          onChange={(value) => set("content", value)}
          label={t("source.content")}
          language="plain"
          className="h-[530px]"
        />
      ) : (
        <div className="grid max-w-[800px] gap-4">
          <Field label={t("source.url")} error={errors.url} hint={t("source.urlHint")}>
            <Input
              value={values.url}
              onChange={(event) => set("url", event.currentTarget.value)}
              mono
              spellCheck={false}
              placeholder="https://github.com/owner/repo.git"
            />
          </Field>
          <Field label={t("source.ref")} error={errors.ref} hint={t("source.refHint")}>
            <Input
              value={values.ref}
              onChange={(event) => set("ref", event.currentTarget.value)}
              mono
              spellCheck={false}
              placeholder="main"
            />
          </Field>
          <Field label={t("source.path")} hint={t("source.pathHint")} error={errors.path}>
            <Input
              value={values.path}
              onChange={(event) => set("path", event.currentTarget.value)}
              mono
              spellCheck={false}
            />
          </Field>
          <Field label={t("source.file")} error={errors.file} hint={t("source.fileHint")}>
            <Input
              value={values.file}
              onChange={(event) => set("file", event.currentTarget.value)}
              mono
              spellCheck={false}
            />
          </Field>
          <SshKeySection project={project} service={service} />
        </div>
      )}
      <div>
        <Button variant="primary" pending={pending} onClick={save}>
          {t("source.save")}
        </Button>
      </div>
    </div>
  );
}

/** The Compose file, inline or from Git, and what the check found in it. */
export function ComposeSourceTab() {
  const { t } = useTranslation(["compose", "common"]);
  const { project, service } = useServiceParams();
  const { data, isPending, isError, error, refetch } = useQuery(composeQuery(project, service));

  return (
    <section className="grid max-w-[1100px] gap-4 px-4 py-6 md:px-6 lg:px-8">
      <SectionIntro pictogram="compose" title={t("source.title")} description={t("source.description")} />
      {isPending ? (
        <Skeleton className="h-60" />
      ) : isError ? (
        <ErrorState message={errorMessage(error, t)} onRetry={() => refetch()} />
      ) : (
        <SourceForm key={service} project={project} service={service} detail={data} />
      )}
    </section>
  );
}
