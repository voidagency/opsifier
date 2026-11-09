import {
  pinnedImage,
  requiresHostAccess,
  resourceName,
  type TemplateDocument,
  type TemplateParam,
  type TemplateService,
} from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type FieldErrors, useForm } from "../../lib/forms";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Field,
  FormBanner,
  Input,
  Markdown,
  PasswordInput,
  Pictogram,
  Select,
  Switch,
  toast,
} from "../../ui";
import { useCurrentUser } from "../auth/session";
import { projectQuery, projectsKey } from "../projects/api";
import { servicePictogram } from "../services/serviceState";
import { templatesApi } from "./api";
import { categoryPictograms, localized } from "./category";

export type TemplateSource = { type: "catalogue"; id: string } | { type: "schema"; schema: string };

type FormValues = Record<string, unknown>;

const NEW_DATABASE = "__new__";

const nameField = (key: string) => `services.${key}.name`;
const imageField = (key: string) => `services.${key}.image`;
const existingField = (key: string) => `services.${key}.existing`;
const paramField = (key: string) => `params.${key}`;

function defaultImage(service: TemplateService): string | null {
  if (service.kind === "database") {
    return service.image;
  }
  return service.kind === "app" && service.source.type === "image" ? service.source.image : null;
}

function initialValues(template: TemplateDocument): FormValues {
  const values: FormValues = { acknowledgeHostAccess: false };
  for (const service of template.services) {
    values[nameField(service.key)] = service.name;
    if (service.kind === "database") {
      values[existingField(service.key)] = NEW_DATABASE;
    }
    const image = defaultImage(service);
    if (image !== null) {
      values[imageField(service.key)] = image;
    }
  }
  for (const param of template.params) {
    values[paramField(param.key)] = param.default ?? (param.type === "boolean" ? false : "");
  }
  return values;
}

function validateValues(
  template: TemplateDocument,
  values: FormValues,
  t: (key: string) => string,
): FieldErrors {
  const errors: FieldErrors = {};
  for (const service of template.services) {
    const existing = service.kind === "database" && values[existingField(service.key)] !== NEW_DATABASE;
    const name = String(values[nameField(service.key)] ?? "");
    if (!existing && !resourceName.safeParse(name).success) {
      errors[nameField(service.key)] = name === "" ? t("form.required") : t("form.invalidName");
    }
    if (defaultImage(service) !== null && !existing) {
      const image = String(values[imageField(service.key)] ?? "");
      if (!pinnedImage.safeParse(image).success) {
        errors[imageField(service.key)] = t("form.invalidImage");
      }
    }
  }
  for (const param of template.params) {
    const value = values[paramField(param.key)];
    if (param.required && (value === "" || value === undefined) && param.type !== "secret") {
      errors[paramField(param.key)] = t("form.required");
    }
  }
  return errors;
}

function paramValue(param: TemplateParam, value: unknown): string | number | boolean {
  if (param.type === "number") {
    return Number(value);
  }
  return value as string | boolean;
}

function ParamField({
  param,
  language,
  form,
}: {
  param: TemplateParam;
  language: string;
  form: ReturnType<typeof useForm<FormValues>>;
}) {
  const { t } = useTranslation("templates");
  const name = paramField(param.key);
  const error = form.errors[name];
  const help = param.help === undefined ? undefined : localized(param.help, language);
  const label = localized(param.label, language);

  if (param.type === "boolean") {
    return (
      <Switch
        label={label}
        hint={help}
        checked={form.values[name] === true}
        onCheckedChange={(checked) => form.set(name, checked)}
      />
    );
  }
  if (param.type === "select") {
    return (
      <Field label={label} hint={help} error={error} optional={!param.required}>
        <Select
          value={String(form.values[name] ?? "")}
          onValueChange={(value) => form.set(name, value)}
          options={(param.options ?? []).map((option) => ({
            value: option.value,
            label: localized(option.label, language),
          }))}
        />
      </Field>
    );
  }
  return (
    <Field label={label} hint={help} error={error} optional={!param.required}>
      {param.type === "secret" ? (
        <PasswordInput
          value={String(form.values[name] ?? "")}
          onChange={(event) => form.set(name, event.currentTarget.value)}
          placeholder={param.generate === undefined ? undefined : t("form.generated")}
          autoComplete="new-password"
        />
      ) : (
        <Input
          value={String(form.values[name] ?? "")}
          onChange={(event) => form.set(name, event.currentTarget.value)}
          inputMode={param.type === "number" ? "numeric" : undefined}
          mono={param.type === "url" || param.type === "email"}
          autoComplete="off"
          spellCheck={false}
        />
      )}
    </Field>
  );
}

function ServiceFields({
  service,
  project,
  form,
}: {
  service: TemplateService;
  project: string;
  form: ReturnType<typeof useForm<FormValues>>;
}) {
  const { t } = useTranslation("templates");
  const { data } = useQuery(projectQuery(project));
  const image = defaultImage(service);
  const existingChoices =
    service.kind === "database"
      ? (data?.services ?? []).filter((candidate) => candidate.type === service.engine)
      : [];
  const usesExisting =
    service.kind === "database" && form.values[existingField(service.key)] !== NEW_DATABASE;

  return (
    <div className="grid gap-3 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <Pictogram
          name={servicePictogram(service.kind === "database" ? service.engine : service.kind)}
          size={16}
          className="text-muted"
        />
        <span className="text-sm font-medium">{t(`form.kinds.${service.kind}`)}</span>
      </div>
      {service.kind === "database" && (
        <Field label={t("form.databaseSource")} hint={t("form.databaseSourceHint")}>
          <Select
            value={String(form.values[existingField(service.key)])}
            onValueChange={(value) => form.set(existingField(service.key), value)}
            options={[
              { value: NEW_DATABASE, label: t("form.newDatabase") },
              ...existingChoices.map((candidate) => ({ value: candidate.name, label: candidate.name })),
            ]}
          />
        </Field>
      )}
      {!usesExisting && (
        <Field label={t("form.name")} error={form.errors[nameField(service.key)]} hint={t("form.nameHint")}>
          <Input {...form.field(nameField(service.key))} mono autoComplete="off" spellCheck={false} />
        </Field>
      )}
      {image !== null && !usesExisting && (
        <Field
          label={t("form.image")}
          error={form.errors[imageField(service.key)]}
          hint={t("form.imageHint")}
        >
          <Input {...form.field(imageField(service.key))} mono autoComplete="off" spellCheck={false} />
        </Field>
      )}
    </div>
  );
}

export function TemplateDialog({
  template,
  project,
  source,
  open,
  onOpenChange,
}: {
  template: TemplateDocument;
  project: string;
  source: TemplateSource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation(["templates", "common"]);
  const language = i18n.language;
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const form = useForm<FormValues>({
    t,
    initialValues: initialValues(template),
    validate: (values) => validateValues(template, values, t),
    onSubmit: async (values) => {
      const services = Object.fromEntries(
        template.services.map((service) => {
          const existing = values[existingField(service.key)];
          return [
            service.key,
            {
              name: String(values[nameField(service.key)]),
              ...(defaultImage(service) === null ? {} : { image: String(values[imageField(service.key)]) }),
              ...(service.kind === "database" && existing !== NEW_DATABASE
                ? { existing: String(existing) }
                : {}),
            },
          ];
        }),
      );
      const params = Object.fromEntries(
        template.params
          .filter((param) => values[paramField(param.key)] !== "")
          .map((param) => [param.key, paramValue(param, values[paramField(param.key)])]),
      );
      const install = await templatesApi.install(project, {
        source,
        services,
        params,
        acknowledgeHostAccess: values.acknowledgeHostAccess === true,
      });
      await queryClient.invalidateQueries({ queryKey: projectsKey });
      onOpenChange(false);
      toast.success(t("form.created", { name: template.name }));
      await navigate({
        to: "/projects/$project/installs/$install",
        params: { project, install: install.id },
      });
    },
  });

  const isAdmin = useCurrentUser()?.role === "admin";
  const hostAccess = requiresHostAccess(template);
  const needsAcknowledge = hostAccess || form.errors.acknowledgeHostAccess !== undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t("form.title", { name: template.name })}
      description={t("form.description", { project })}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={form.pending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t("form.submit")}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
        <div className="grid content-start gap-4">
          {form.banner && <FormBanner>{form.banner}</FormBanner>}
          {needsAcknowledge && (
            <div className="grid gap-2 rounded-sm border p-3">
              <FormBanner tone="warning" title={t("form.hostAccessTitle")}>
                {t("form.hostAccessBody")}
              </FormBanner>
              {isAdmin ? (
                <Checkbox
                  label={t("form.hostAccessConfirm")}
                  checked={form.values.acknowledgeHostAccess === true}
                  onChange={(event) => form.set("acknowledgeHostAccess", event.currentTarget.checked)}
                />
              ) : (
                <p className="text-sm text-muted">{t("form.hostAccessAdminOnly")}</p>
              )}
              {form.errors.acknowledgeHostAccess && (
                <p className="text-xs text-bad">{form.errors.acknowledgeHostAccess}</p>
              )}
            </div>
          )}
          {template.services.map((service) => (
            <ServiceFields key={service.key} service={service} project={project} form={form} />
          ))}
          {template.params.length > 0 && (
            <div className="grid gap-3 border-t pt-3">
              {template.params.map((param) => (
                <ParamField key={param.key} param={param} language={language} form={form} />
              ))}
            </div>
          )}
        </div>
        <aside className="grid content-start gap-3 text-sm">
          <div className="flex items-center gap-2 text-muted">
            <Pictogram name={categoryPictograms[template.category]} />
            <span>{t(`categories.${template.category}`)}</span>
          </div>
          <Markdown text={localized(template.description, language)} className="grid gap-2 text-sm" />
          {template.verified && <Badge tone="ok">{t("catalogue.verified")}</Badge>}
          <ul className="grid gap-1.5 border-t pt-3">
            {template.services.map((service) => (
              <li key={service.key} className="flex min-w-0 items-center gap-2">
                <Pictogram
                  name={servicePictogram(service.kind === "database" ? service.engine : service.kind)}
                  size={16}
                  className="text-muted"
                />
                <span className="truncate font-mono text-xs">{service.name}</span>
              </li>
            ))}
          </ul>
          {template.links.length > 0 && (
            <ul className="grid gap-1 border-t pt-3">
              {template.links.map((link) => (
                <li key={link.url}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-xs underline"
                  >
                    {t(`links.${link.kind}`)}
                    <ExternalLink aria-hidden="true" className="size-3" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </Dialog>
  );
}
