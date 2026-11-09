import {
  type BoxBuildEntry,
  type BoxChange,
  type BoxDetail,
  type BoxModuleChoice,
  type BoxModuleDefinition,
  type BoxModuleId,
  type BoxModulesConfig,
  type BoxPresetId,
  boxMatrix,
  boxModuleIds,
  boxModuleIssues,
  boxPresets,
} from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../../../lib/format";
import { errorMessage } from "../../../../lib/forms";
import {
  Button,
  ConfirmDialog,
  countStates,
  EmptyState,
  ErrorState,
  Field,
  FormBanner,
  HealthSummary,
  Input,
  Lamp,
  MonoValue,
  Pictogram,
  SectionIntro,
  Select,
  Skeleton,
  Switch,
  stateFromAction,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Tooltip,
  TR,
  toast,
  type VisualState,
} from "../../../../ui";
import { boxApi, boxQuery } from "../../../box/api";
import { serviceKey, useServiceParams } from "../../api";

type ModuleState = "built" | "waiting" | "off";

const visualOf = (state: ModuleState): VisualState =>
  state === "built" ? "running" : state === "waiting" ? "degraded" : "stopped";

function moduleState(id: BoxModuleId, detail: BoxDetail, enabled: boolean): ModuleState {
  if (!enabled) {
    return "off";
  }
  const built = detail.built?.modules[id];
  if (built === undefined) {
    return "waiting";
  }
  return detail.pendingChanges.some(
    (change) => change.subject === id || change.subject === `${id} extensions`,
  )
    ? "waiting"
    : "built";
}

function Extensions({
  definition,
  choice,
  onChange,
}: {
  definition: BoxModuleDefinition;
  choice: BoxModuleChoice;
  onChange: (next: BoxModuleChoice) => void;
}) {
  const { t } = useTranslation("service-box-modules");
  return (
    <div className="flex flex-wrap gap-1.5">
      {definition.extensions.map((extension) => {
        const active = choice.extensions.includes(extension.id);
        const available = extension.onlyOn === undefined || extension.onlyOn.includes(choice.version);
        const button = (
          <button
            key={extension.id}
            type="button"
            disabled={!available && !active}
            aria-pressed={active}
            onClick={() =>
              onChange({
                ...choice,
                extensions: active
                  ? choice.extensions.filter((id) => id !== extension.id)
                  : [...choice.extensions, extension.id],
              })
            }
            className="rounded-sm border border-off px-2.5 py-1 font-mono text-sm hover:bg-wash disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-on-accent"
          >
            {extension.id}
          </button>
        );
        return available ? (
          button
        ) : (
          <Tooltip
            key={extension.id}
            content={t("extensions.notOn", {
              version: choice.version,
              versions: (extension.onlyOn ?? []).join(", "),
            })}
          >
            <span className="inline-flex">{button}</span>
          </Tooltip>
        );
      })}
    </div>
  );
}

function ModuleRow({
  definition,
  draft,
  detail,
  error,
  onToggle,
  onChoose,
  onDocumentRoot,
}: {
  definition: BoxModuleDefinition;
  draft: BoxModulesConfig;
  detail: BoxDetail;
  error: string | undefined;
  onToggle: (enabled: boolean) => void;
  onChoose: (next: BoxModuleChoice) => void;
  onDocumentRoot: (value: string) => void;
}) {
  const { t } = useTranslation("service-box-modules");
  const { id } = definition;
  const enabled = draft[id] !== null;
  const state = moduleState(id, detail, enabled);
  const choice = id === "nginx" ? null : (draft[id] as BoxModuleChoice | null);
  const pin = definition.versions.find(
    (candidate) => candidate.version === (choice?.version ?? definition.defaultVersion),
  )?.pin;

  return (
    <li className="grid gap-4 border-b py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div className="flex items-start gap-3">
        <span className="mt-0.5">
          <Switch
            aria-label={t("toggle", { name: t(`modules.${id}.name`) })}
            checked={enabled}
            onCheckedChange={onToggle}
          />
        </span>
        <Lamp state={visualOf(state)} size="md" label={t(`state.${state}`)} className="mt-0.5" />
        <div className="min-w-0">
          <h3 className="font-medium">{t(`modules.${id}.name`)}</h3>
          <p className="text-sm text-muted">{t(`modules.${id}.hint`)}</p>
        </div>
      </div>
      {enabled && (
        <div className="grid gap-3">
          {choice !== null && (
            <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
              <Field label={t("version")} hint={t("versionHint")} className="w-40">
                <Select
                  value={choice.version}
                  aria-label={t("versionOf", { name: t(`modules.${id}.name`) })}
                  onValueChange={(version) =>
                    onChoose({
                      version,
                      extensions: choice.extensions.filter((name) => {
                        const extension = definition.extensions.find((candidate) => candidate.id === name);
                        return extension?.onlyOn === undefined || extension.onlyOn.includes(version);
                      }),
                    })
                  }
                  options={definition.versions.map(({ version }) => ({ value: version, label: version }))}
                />
              </Field>
              {pin !== undefined && (
                <Tooltip content={t("pinHint")}>
                  <span className="inline-flex items-center gap-1.5 pb-1.5 text-sm text-muted">
                    <MonoValue value={pin} />
                  </span>
                </Tooltip>
              )}
            </div>
          )}
          {id === "nginx" && draft.nginx !== null && (
            <Field label={t("documentRoot")} hint={t("documentRootHint")} className="max-w-sm">
              <Input
                mono
                value={draft.nginx.documentRoot}
                onChange={(event) => onDocumentRoot(event.currentTarget.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
          )}
          {choice !== null && definition.extensions.length > 0 && (
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">{t("extensions.label")}</span>
              <Extensions definition={definition} choice={choice} onChange={onChoose} />
            </div>
          )}
          {error !== undefined && <FormBanner>{error}</FormBanner>}
        </div>
      )}
    </li>
  );
}

function ModulesForm({ detail, project, service }: { detail: BoxDetail; project: string; service: string }) {
  const { t } = useTranslation(["service-box-modules", "common"]);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<BoxModulesConfig>(detail.modules);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const counts = countStates(
    boxMatrix.map((definition) =>
      visualOf(moduleState(definition.id, detail, detail.modules[definition.id] !== null)),
    ),
  );

  const changeModule = (id: BoxModuleId, value: BoxModuleChoice | BoxModulesConfig["nginx"]) => {
    setDraft((current) => ({ ...current, [id]: value }));
    setFieldErrors({});
  };

  const toggle = (definition: BoxModuleDefinition, enabled: boolean) => {
    if (!enabled) {
      changeModule(definition.id, null);
    } else if (definition.id === "nginx") {
      changeModule("nginx", { documentRoot: "public" });
    } else {
      changeModule(definition.id, { version: definition.defaultVersion, extensions: [] });
    }
  };

  const save = async () => {
    const issues = boxModuleIssues(draft);
    if (issues.length > 0) {
      setFieldErrors(Object.fromEntries(issues.map(({ field, message }) => [field, message])));
      return;
    }
    setSaving(true);
    setBanner(null);
    try {
      await boxApi.saveModules(project, service, draft);
      await queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
      toast.success(t("saved"));
    } catch (error) {
      setBanner(errorMessage(error, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="grid gap-4">
      <SectionIntro
        pictogram="box"
        title={t("title")}
        description={t("description", { revision: detail.matrixRevision })}
      />
      <HealthSummary variant="row" counts={counts} label={t("title")} />
      {detail.issues.map((issue) => (
        <FormBanner key={issue.field}>{issue.message}</FormBanner>
      ))}
      <ul className="border-t">
        {boxMatrix.map((definition) => (
          <ModuleRow
            key={definition.id}
            definition={definition}
            draft={draft}
            detail={detail}
            error={fieldErrors[`${definition.id}.version`] ?? fieldErrors[`${definition.id}.extensions`]}
            onToggle={(enabled) => toggle(definition, enabled)}
            onChoose={(next) => changeModule(definition.id, next)}
            onDocumentRoot={(documentRoot) => changeModule("nginx", { documentRoot })}
          />
        ))}
      </ul>
      <p className="text-sm text-muted">{t("nothingElse")}</p>
      {banner !== null && <FormBanner>{banner}</FormBanner>}
      <div>
        <Button variant="primary" pending={saving} onClick={save}>
          {t("save")}
        </Button>
      </div>
    </section>
  );
}

function PendingChanges({ changes }: { changes: readonly BoxChange[] }) {
  const { t } = useTranslation("service-box-modules");
  if (changes.length === 0) {
    return null;
  }
  return (
    <section className="grid gap-2">
      <SectionIntro
        pictogram="deployment"
        title={t("pending.title")}
        description={t("pending.description")}
      />
      <ul className="grid gap-1.5 border-t pt-3">
        {changes.map((change) => (
          <li
            key={`${change.kind}:${change.subject}`}
            className="flex flex-wrap items-center gap-x-2.5 gap-y-1"
          >
            <Lamp
              state={change.kind === "security" ? "failed" : "degraded"}
              size="sm"
              label={t(`changes.kind.${change.kind}`)}
            />
            <ChangeLine change={change} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChangeLine({ change }: { change: BoxChange }) {
  const { t } = useTranslation("service-box-modules");
  return (
    <span>
      <span className="font-medium">{t(`changes.kind.${change.kind}`)}</span>
      {" · "}
      <span className="font-mono">{change.subject}</span>
      {change.from !== null || change.to !== null ? (
        <span className="font-mono text-muted">
          {" "}
          {change.from ?? t("changes.none")} → {change.to ?? t("changes.none")}
        </span>
      ) : null}
    </span>
  );
}

function Presets({
  project,
  service,
  current,
}: {
  project: string;
  service: string;
  current: BoxDetail["preset"];
}) {
  const { t } = useTranslation("service-box-modules");
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<BoxPresetId | null>(null);

  const apply = async () => {
    if (confirming === null) {
      return;
    }
    await boxApi.applyPreset(project, service, { preset: confirming });
    await queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
    toast.success(t("presets.applied"));
    setConfirming(null);
  };

  return (
    <section className="grid gap-3">
      <SectionIntro pictogram="template" title={t("presets.title")} description={t("presets.description")} />
      <ul className="border-t">
        {boxPresets.map((preset) => (
          <li key={preset.id} className="flex flex-wrap items-center justify-between gap-3 border-b py-3">
            <div className="min-w-0">
              <h3 className="font-medium">
                {t(`presets.${preset.id}.name`, { ns: "box" })}
                {current === preset.id && (
                  <span className="ml-2 text-sm font-normal text-muted">{t("presets.current")}</span>
                )}
              </h3>
              <p className="text-sm text-muted">{t(`presets.${preset.id}.hint`, { ns: "box" })}</p>
            </div>
            <Button onClick={() => setConfirming(preset.id)}>{t("presets.apply")}</Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(null);
          }
        }}
        title={t("presets.confirmTitle")}
        description={confirming === null ? "" : t(`presets.${confirming}.name`, { ns: "box" })}
        confirmLabel={t("presets.apply")}
        tone="primary"
        onConfirm={apply}
      >
        <p>{t("presets.confirmBody")}</p>
      </ConfirmDialog>
    </section>
  );
}

function History({ history }: { history: readonly BoxBuildEntry[] }) {
  const { t, i18n } = useTranslation("service-box-modules");
  return (
    <section className="grid gap-3">
      <SectionIntro
        pictogram="deployment"
        title={t("history.title")}
        description={t("history.description")}
      />
      {history.length === 0 ? (
        <EmptyState title={t("history.emptyTitle")} description={t("history.emptyBody")} />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>{t("history.outcome")}</TH>
              <TH>{t("history.reason")}</TH>
              <TH>{t("history.changes")}</TH>
              <TH>{t("history.when")}</TH>
              <TH>{t("history.by")}</TH>
            </TR>
          </THead>
          <TBody>
            {history.map((entry) => (
              <TR key={entry.actionId}>
                <TD>
                  <Lamp
                    state={stateFromAction(entry.status)}
                    showLabel
                    label={t(`history.status.${entry.status}`)}
                  />
                </TD>
                <TD>{t(`reasons.${entry.reason}`)}</TD>
                <TD>
                  {entry.changes.length === 0 ? (
                    <span className="text-muted">{t("history.noChange")}</span>
                  ) : (
                    <ul className="grid gap-0.5">
                      {entry.changes.map((change) => (
                        <li key={`${change.kind}:${change.subject}`}>
                          <ChangeLine change={change} />
                        </li>
                      ))}
                    </ul>
                  )}
                  {entry.error !== null && <p className="mt-1 text-sm text-bad">{entry.error}</p>}
                </TD>
                <TD>{formatRelativeTime(entry.at, i18n.language)}</TD>
                <TD>{entry.actorEmail ?? t("history.nobody")}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </section>
  );
}

function GeneratedImage({ dockerfile }: { dockerfile: string }) {
  const { t } = useTranslation("service-box-modules");
  return (
    <section className="grid gap-3">
      <SectionIntro
        pictogram="dockerfile"
        title={t("dockerfile.title")}
        description={t("dockerfile.description")}
      />
      <details>
        <summary className="cursor-pointer text-sm hover:text-ink">{t("dockerfile.show")}</summary>
        <pre className="mt-3 max-h-[480px] overflow-auto rounded-sm border bg-raised p-3 font-mono text-sm">
          {dockerfile}
        </pre>
      </details>
    </section>
  );
}

/** What this box is built from: the matrix as a table of lamps, then why each build happened. */
export function BoxModulesTab() {
  const { t } = useTranslation("service-box-modules");
  const { project, service } = useServiceParams();
  // A deployment runs on the server: this is how its build lands in the history below.
  const query = useQuery({ ...boxQuery(project, service), refetchInterval: 5000 });

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

  const detail = query.data;
  return (
    <div className="grid max-w-[1130px] gap-8 px-4 py-6 md:px-6 lg:px-8">
      <ModulesForm
        key={boxModuleIds.map((id) => JSON.stringify(detail.modules[id])).join()}
        detail={detail}
        project={project}
        service={service}
      />
      <PendingChanges changes={detail.pendingChanges} />
      <Presets project={project} service={service} current={detail.preset} />
      <History history={detail.history} />
      <GeneratedImage dockerfile={detail.dockerfile} />
      <p className="flex items-center gap-2 text-sm text-muted">
        <Pictogram name="box" size={16} />
        {t("matrixFootnote", { revision: detail.matrixRevision })}
      </p>
    </div>
  );
}
