import {
  backupSchedulePresets,
  DEFAULT_SCRIPT_MAX_SECONDS,
  presetOfCron,
  type ScriptSpec,
  scriptSpec,
} from "@opsifier/contract";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "../../../../lib/forms";
import {
  Button,
  Checkbox,
  CodeEditor,
  Dialog,
  Field,
  FormBanner,
  Input,
  Select,
  Switch,
  toast,
} from "../../../../ui";
import { scriptsApi } from "./api";

export interface ScriptDialogProps {
  project: string;
  service: string;
  /** The script being edited with its position, or undefined to create one. */
  editing?: { index: number; script: ScriptSpec };
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}

interface Values extends Record<string, unknown> {
  name: string;
  script: string;
  maxDurationSeconds: string;
  scheduled: boolean;
  cron: string;
  timeZone: string;
  runAfterDeploy: boolean;
}

const CUSTOM = "custom";
const DEFAULT_CRON = "0 3 * * *";

const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function payloadOf(values: Values): unknown {
  return {
    name: values.name,
    script: values.script,
    maxDurationSeconds: values.maxDurationSeconds,
    schedule: values.scheduled ? { cron: values.cron, timeZone: values.timeZone } : null,
    runAfterDeploy: values.runAfterDeploy,
  };
}

type FieldName = "name" | "script" | "maxDurationSeconds" | "cron" | "timeZone";

export function ScriptDialog({ project, service, editing, onClose, onSaved }: ScriptDialogProps) {
  const { t } = useTranslation(["service-scripts", "common"]);
  const zoneList = useId();
  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  const saved = editing?.script;
  const form = useForm<Values>({
    t,
    initialValues: {
      name: saved?.name ?? "",
      script: saved?.script ?? "",
      maxDurationSeconds: String(saved?.maxDurationSeconds ?? DEFAULT_SCRIPT_MAX_SECONDS),
      scheduled: saved?.schedule != null,
      cron: saved?.schedule?.cron ?? DEFAULT_CRON,
      timeZone: saved?.schedule?.timeZone ?? browserTimeZone(),
      runAfterDeploy: saved?.runAfterDeploy ?? false,
    },
    validate: (values) => {
      const result = scriptSpec.safeParse(payloadOf(values));
      if (result.success) {
        return {};
      }
      const messages: Record<FieldName, string> = {
        name: t("errors.name"),
        script: t("errors.script"),
        maxDurationSeconds: t("errors.maxDurationSeconds"),
        cron: t("errors.cron"),
        timeZone: t("errors.timeZone"),
      };
      const errors: Partial<Record<FieldName, string>> = {};
      for (const issue of result.error.issues) {
        const field = (issue.path[0] === "schedule" ? issue.path[1] : issue.path[0]) as FieldName;
        errors[field] ??= messages[field] ?? issue.message;
      }
      return errors;
    },
    onSubmit: async (values) => {
      const script = scriptSpec.parse(payloadOf(values));
      if (editing === undefined) {
        await scriptsApi.add(project, service, script);
      } else {
        await scriptsApi.update(project, service, editing.index, script);
      }
      await onSaved();
      toast.success(t("saved"));
      onClose();
    },
  });

  const [customPreset, setCustomPreset] = useState(false);
  const preset = customPreset ? CUSTOM : (presetOfCron(form.values.cron) ?? CUSTOM);
  const presetOptions = [
    ...backupSchedulePresets.map((entry) => ({
      value: entry.key,
      label: t(`dialog.presets.${entry.key}`),
    })),
    { value: CUSTOM, label: t("dialog.presets.custom") },
  ];
  const onPreset = (value: string) => {
    if (value === CUSTOM) {
      setCustomPreset(true);
      return;
    }
    setCustomPreset(false);
    const chosen = backupSchedulePresets.find((entry) => entry.key === value);
    if (chosen !== undefined) {
      form.set("cron", chosen.cron);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title={editing === undefined ? t("dialog.createTitle") : t("dialog.updateTitle")}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={form.pending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {editing === undefined ? t("dialog.create") : t("dialog.save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Field label={t("dialog.name")} error={form.errors.name} hint={t("dialog.nameHint")}>
          <Input {...form.field("name")} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label={t("dialog.script")} hint={t("dialog.scriptHint")} error={form.errors.script}>
          <CodeEditor
            value={form.values.script}
            onChange={(value) => form.set("script", value)}
            label={t("dialog.script")}
            language="plain"
            invalid={form.errors.script !== undefined}
          />
        </Field>
        <Field
          label={t("dialog.maxDuration")}
          hint={t("dialog.maxDurationHint")}
          error={form.errors.maxDurationSeconds}
        >
          <Input {...form.field("maxDurationSeconds")} inputMode="numeric" autoComplete="off" />
        </Field>
        <Switch
          label={t("dialog.scheduled")}
          hint={t("dialog.scheduledHint")}
          checked={form.values.scheduled}
          onCheckedChange={(checked) => form.set("scheduled", checked)}
        />
        {form.values.scheduled && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("dialog.schedule")} hint={t("dialog.scheduleHint")}>
                <Select value={preset} onValueChange={onPreset} options={presetOptions} />
              </Field>
              <Field label={t("dialog.cron")} hint={t("dialog.cronHint")} error={form.errors.cron}>
                <Input
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  value={form.values.cron}
                  onChange={(event) => {
                    setCustomPreset(false);
                    form.set("cron", event.currentTarget.value);
                  }}
                />
              </Field>
            </div>
            <Field label={t("dialog.timeZone")} hint={t("dialog.timeZoneHint")} error={form.errors.timeZone}>
              <Input {...form.field("timeZone")} mono autoComplete="off" spellCheck={false} list={zoneList} />
              <datalist id={zoneList}>
                {zones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </Field>
          </>
        )}
        <Checkbox
          label={t("dialog.runAfterDeploy")}
          hint={t("dialog.runAfterDeployHint")}
          checked={form.values.runAfterDeploy}
          onChange={(event) => form.set("runAfterDeploy", event.currentTarget.checked)}
        />
      </div>
    </Dialog>
  );
}
