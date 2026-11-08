import {
  MAX_MAINTENANCE_LOGO_BYTES,
  type MaintenanceSettings,
  maintenanceSettings,
} from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, schemaErrors, useForm } from "../../../../lib/forms";
import { Button, Field, FormBanner, Input, Skeleton, Switch, Textarea, toast } from "../../../../ui";
import { serviceKey, useServiceParams } from "../../api";
import { maintenanceApi, maintenanceQuery } from "./api";

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

function MaintenanceForm({
  project,
  service,
  initial,
}: {
  project: string;
  service: string;
  initial: MaintenanceSettings;
}) {
  const { t } = useTranslation(["service-maintenance", "common"]);
  const queryClient = useQueryClient();
  const [logoError, setLogoError] = useState<string | null>(null);

  const form = useForm<MaintenanceSettings & Record<string, unknown>>({
    t,
    initialValues: initial,
    validate: (values) => {
      const errors = schemaErrors<"title" | "subtitle" | "customCss" | "customLogo">(
        maintenanceSettings,
        values,
        {
          title: t("errors.tooLong"),
          subtitle: t("errors.tooLong"),
          customCss: t("errors.css"),
          customLogo: t("errors.logo"),
        },
      );
      return errors;
    },
    onSubmit: async (values) => {
      const saved = await maintenanceApi.save(project, service, values);
      form.reset(saved);
      await queryClient.invalidateQueries({ queryKey: serviceKey(project, service) });
      toast.success(saved.enabled ? t("savedOn") : t("savedOff"), t("savedHint"));
    },
  });

  const chooseLogo = async (file: File | undefined) => {
    setLogoError(null);
    if (file === undefined) {
      return;
    }
    if (file.size * 1.4 > MAX_MAINTENANCE_LOGO_BYTES) {
      setLogoError(t("errors.logoTooLarge"));
      return;
    }
    try {
      form.set("customLogo", await readAsDataUrl(file));
    } catch {
      setLogoError(t("errors.logoUnreadable"));
    }
  };

  const logo = form.values.customLogo;

  return (
    <form onSubmit={form.handleSubmit} noValidate className="grid max-w-[520px] gap-4">
      {form.banner && <FormBanner>{form.banner}</FormBanner>}
      {initial.enabled && (
        <FormBanner tone="warning" title={t("activeTitle")}>
          {t("activeHint")}
        </FormBanner>
      )}
      <Switch
        label={t("enabled")}
        hint={t("enabledHint")}
        checked={form.values.enabled}
        onCheckedChange={(checked) => form.set("enabled", checked)}
      />
      <Field label={t("pageTitle")} hint={t("pageTitleHint")} optional error={form.errors.title}>
        <Input {...form.field("title")} autoComplete="off" />
      </Field>
      <Field label={t("subtitle")} optional error={form.errors.subtitle}>
        <Input {...form.field("subtitle")} autoComplete="off" />
      </Field>
      <fieldset className="m-0 grid gap-4 border-0 p-0">
        <legend className="eyebrow mb-1">{t("customize")}</legend>
        <Field label={t("logo")} hint={t("logoHint")} optional error={logoError ?? form.errors.customLogo}>
          <div className="flex flex-wrap items-center gap-3">
            {logo !== null && (
              <img
                src={logo}
                alt={t("logoPreview")}
                className="h-10 max-w-[160px] border bg-raised object-contain"
              />
            )}
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
              aria-label={t("logoChoose")}
              className="text-sm file:mr-2 file:h-8 file:rounded-sm file:border file:border-off file:bg-raised file:px-2.5 file:text-sm file:text-ink"
              onChange={(event) => {
                void chooseLogo(event.currentTarget.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
            {logo !== null && (
              <Button
                onClick={() => {
                  form.set("customLogo", null);
                  setLogoError(null);
                }}
              >
                {t("logoRemove")}
              </Button>
            )}
          </div>
        </Field>
        <Field label={t("css")} hint={t("cssHint")} optional error={form.errors.customCss}>
          <Textarea {...form.field("customCss")} mono rows={5} spellCheck={false} />
        </Field>
        <Switch
          label={t("hideLogo")}
          checked={form.values.hideLogo}
          onCheckedChange={(checked) => form.set("hideLogo", checked)}
        />
        <Switch
          label={t("hideLinks")}
          hint={t("hideLinksHint")}
          checked={form.values.hideLinks}
          onCheckedChange={(checked) => form.set("hideLinks", checked)}
        />
      </fieldset>
      <div>
        <Button type="submit" variant="primary" pending={form.pending}>
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}

export function MaintenanceTab() {
  const { t } = useTranslation(["service-maintenance", "common"]);
  const { project, service } = useServiceParams();
  const { data, isPending, isError, error, refetch } = useQuery(maintenanceQuery(project, service));

  return (
    <section className="grid gap-x-10 gap-y-4 px-4 py-6 md:px-6 lg:grid-cols-[minmax(0,260px)_minmax(0,520px)] lg:px-8">
      <div>
        <h2 className="text-md font-medium">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted">{t("description")}</p>
      </div>
      {isPending ? (
        <Skeleton className="h-72" />
      ) : isError ? (
        <div className="grid justify-items-start gap-3">
          <FormBanner>{errorMessage(error, t)}</FormBanner>
          <Button onClick={() => refetch()}>{t("common:actions.retry")}</Button>
        </div>
      ) : (
        <MaintenanceForm key={service} project={project} service={service} initial={data} />
      )}
    </section>
  );
}
