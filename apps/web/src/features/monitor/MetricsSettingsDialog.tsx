import { metricsRanges, metricsSteps } from "@opsifier/contract";
import { useTranslation } from "react-i18next";
import { Button, Dialog, Field, Segmented } from "../../ui";
import { refreshChoices, useMetricsPreferences } from "./preferences";

interface MetricsSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Applies as you click: there is nothing to save or get wrong. */
export function MetricsSettingsDialog({ open, onOpenChange }: MetricsSettingsDialogProps) {
  const { t } = useTranslation("monitor");
  const [preferences, update] = useMetricsPreferences();

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("settings.title")}
      size="md"
      footer={<Button onClick={() => onOpenChange(false)}>{t("common:actions.close")}</Button>}
    >
      <div className="grid gap-4">
        <Field label={t("settings.refresh")} hint={t("settings.refreshHint")}>
          <Segmented
            label={t("settings.refresh")}
            value={preferences.refresh}
            onChange={(refresh) => update({ refresh })}
            options={refreshChoices.map((value) => ({
              value,
              label: value === "off" ? t("settings.off") : value,
            }))}
          />
        </Field>
        <Field label={t("settings.range")} hint={t("settings.rangeHint")}>
          <Segmented
            label={t("settings.range")}
            value={preferences.range}
            onChange={(range) => update({ range })}
            options={metricsRanges.map((value) => ({ value, label: value }))}
          />
        </Field>
        <Field label={t("settings.step")} hint={t("settings.stepHint")}>
          <Segmented
            label={t("settings.step")}
            value={preferences.step}
            onChange={(step) => update({ step })}
            options={metricsSteps.map((value) => ({ value, label: value }))}
          />
        </Field>
      </div>
    </Dialog>
  );
}
