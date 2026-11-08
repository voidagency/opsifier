import { type DomainEntry, type SaveDomainRequest, saveDomainRequest } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type FieldErrors, schemaErrors, useForm } from "../../../../lib/forms";
import {
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FormBanner,
  Input,
  Select,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "../../../../ui";
import { domainsApi, exposedPortsQuery } from "./api";

interface DomainFormValues {
  https: boolean;
  host: string;
  path: string;
  destinationProtocol: "http" | "https";
  port: string;
  destinationPath: string;
  certificateResolver: string;
  wildcard: boolean;
  middlewares: string[];
  [key: string]: unknown;
}

type Name = "details" | "middlewares" | "ssl";

const tabOfField: Record<string, Name> = {
  host: "details",
  path: "details",
  port: "details",
  destinationPath: "details",
  destinationProtocol: "details",
  https: "details",
  middlewares: "middlewares",
  certificateResolver: "ssl",
  wildcard: "ssl",
};

const blank: DomainFormValues = {
  https: true,
  host: "",
  path: "/",
  destinationProtocol: "http",
  port: "80",
  destinationPath: "/",
  certificateResolver: "",
  wildcard: false,
  middlewares: [],
};

const valuesFrom = (domain: DomainEntry): DomainFormValues => ({
  https: domain.https,
  host: domain.host,
  path: domain.path,
  destinationProtocol: domain.destinationProtocol,
  port: String(domain.port),
  destinationPath: domain.destinationPath,
  certificateResolver: domain.certificateResolver ?? "",
  wildcard: domain.wildcard,
  middlewares: domain.middlewares,
});

const toRequest = (values: DomainFormValues): SaveDomainRequest => ({
  https: values.https,
  host: values.host,
  path: values.path,
  destinationProtocol: values.destinationProtocol,
  port: values.port.trim() === "" ? Number.NaN : Number(values.port),
  destinationPath: values.destinationPath,
  certificateResolver: values.certificateResolver === "" ? null : values.certificateResolver,
  wildcard: values.wildcard,
  middlewares: values.middlewares,
});

function PortSuggestions({
  project,
  service,
  onSelect,
}: {
  project: string;
  service: string;
  onSelect: (port: number) => void;
}) {
  const { t } = useTranslation("service-domains");
  const { data, isPending, isError } = useQuery(exposedPortsQuery(project, service));
  const ports = data?.ports ?? [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="md" className="h-9 shrink-0">
          {t("dialog.selectPort")}
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-[140px]">
        {isPending ? (
          <DropdownMenuItem disabled>{t("dialog.portsLoading")}</DropdownMenuItem>
        ) : isError || ports.length === 0 ? (
          <DropdownMenuItem disabled>{t("dialog.noSuggestions")}</DropdownMenuItem>
        ) : (
          ports.map((port) => (
            <DropdownMenuItem key={port} onSelect={() => onSelect(port)} className="font-mono">
              {port}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface DomainDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: string;
  service: string;
  /** The domain being edited, or undefined to create one. */
  domain?: DomainEntry;
  onSaved: () => Promise<unknown>;
}

function DomainForm({ project, service, domain, onOpenChange, onSaved }: Omit<DomainDialogProps, "open">) {
  const { t } = useTranslation(["service-domains", "common"]);
  const [tab, setTab] = useState<Name>("details");
  const form = useForm<DomainFormValues>({
    t,
    initialValues: domain === undefined ? blank : valuesFrom(domain),
    validate: (values) => {
      const errors = schemaErrors<string>(saveDomainRequest, toRequest(values), {
        host: t("errors.host"),
        path: t("errors.path"),
        port: t("errors.port"),
        destinationPath: t("errors.destinationPath"),
        certificateResolver: t("errors.resolver"),
        middlewares: t("errors.middlewares"),
      }) as FieldErrors<keyof DomainFormValues & string>;
      if (errors.certificateResolver !== undefined && values.certificateResolver.trim() === "") {
        errors.certificateResolver = t("errors.resolverRequired");
      }
      return errors;
    },
    onSubmit: async (values) => {
      const request = toRequest(values);
      if (domain === undefined) {
        await domainsApi.create(project, service, request);
        toast.success(t("created"));
      } else {
        await domainsApi.update(project, service, domain.id, request);
        toast.success(t("updated"));
      }
      await onSaved();
      onOpenChange(false);
    },
  });

  const { errors } = form;
  // Anything wrong on a tab that isn't showing would otherwise go unseen.
  useEffect(() => {
    const first = Object.keys(errors).find((name) => tabOfField[name] !== undefined);
    if (first !== undefined) {
      setTab(tabOfField[first] as Name);
    }
  }, [errors]);

  const invalid = (names: readonly string[]) => names.some((name) => (errors as FieldErrors)[name]);
  const setMiddleware = (index: number, value: string) =>
    form.set(
      "middlewares",
      form.values.middlewares.map((name, position) => (position === index ? value : name)),
    );

  const detailsFields = ["host", "path", "port", "destinationPath", "destinationProtocol"];

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      size="md"
      title={domain === undefined ? t("dialog.createTitle") : t("dialog.updateTitle")}
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={form.pending}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {domain === undefined ? t("dialog.create") : t("dialog.save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Tabs value={tab} onValueChange={(value) => setTab(value as Name)}>
          <TabsList>
            <TabsTrigger value="details" className={invalid(detailsFields) ? "text-bad" : undefined}>
              {t("dialog.tabs.details")}
            </TabsTrigger>
            <TabsTrigger value="middlewares" className={invalid(["middlewares"]) ? "text-bad" : undefined}>
              {t("dialog.tabs.middlewares")}
            </TabsTrigger>
            <TabsTrigger
              value="ssl"
              className={invalid(["certificateResolver", "wildcard"]) ? "text-bad" : undefined}
            >
              {t("dialog.tabs.ssl")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="details" className="grid gap-4 pt-4">
            <Switch
              label={t("dialog.https")}
              hint={t("dialog.httpsHint")}
              checked={form.values.https}
              onCheckedChange={(checked) => form.set("https", checked)}
            />
            <Field label={t("dialog.host")} error={errors.host}>
              <Input
                {...form.field("host")}
                mono
                placeholder="app.example.com"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
              />
            </Field>
            <Field label={t("dialog.path")} hint={t("dialog.pathHint")} error={errors.path}>
              <Input
                {...form.field("path")}
                mono
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
              />
            </Field>
            <fieldset className="m-0 grid gap-4 border-0 p-0">
              <legend className="eyebrow mb-1">{t("dialog.destination")}</legend>
              <div className="grid items-start gap-3 sm:grid-cols-[120px_minmax(0,1fr)]">
                <Field label={t("dialog.protocol")} error={errors.destinationProtocol}>
                  <Select
                    value={form.values.destinationProtocol}
                    onValueChange={(value) =>
                      form.set("destinationProtocol", value as DomainFormValues["destinationProtocol"])
                    }
                    options={[
                      { value: "http", label: "HTTP" },
                      { value: "https", label: "HTTPS" },
                    ]}
                  />
                </Field>
                <Field label={t("dialog.port")} hint={t("dialog.portHint")} error={errors.port}>
                  <div className="flex gap-2">
                    <Input
                      {...form.field("port")}
                      mono
                      type="number"
                      min={1}
                      max={65535}
                      inputMode="numeric"
                      autoComplete="off"
                    />
                    <PortSuggestions
                      project={project}
                      service={service}
                      onSelect={(port) => form.set("port", String(port))}
                    />
                  </div>
                </Field>
              </div>
              <Field
                label={t("dialog.destinationPath")}
                hint={t("dialog.destinationPathHint")}
                error={errors.destinationPath}
              >
                <Input
                  {...form.field("destinationPath")}
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="none"
                />
              </Field>
            </fieldset>
          </TabsContent>

          <TabsContent value="middlewares" className="grid gap-3 pt-4">
            <p className="text-sm text-muted">{t("dialog.middlewaresHint")}</p>
            {errors.middlewares && <FormBanner>{errors.middlewares}</FormBanner>}
            {form.values.middlewares.map((name, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
              <div key={index} className="flex items-end gap-2">
                <Field label={t("dialog.middleware", { number: index + 1 })} className="min-w-0 flex-1">
                  <Input
                    value={name}
                    onChange={(event) => setMiddleware(index, event.currentTarget.value)}
                    mono
                    placeholder="rate-limit@file"
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="none"
                  />
                </Field>
                <Button
                  size="icon"
                  aria-label={t("dialog.removeMiddleware", { number: index + 1 })}
                  onClick={() =>
                    form.set(
                      "middlewares",
                      form.values.middlewares.filter((_, position) => position !== index),
                    )
                  }
                >
                  <X aria-hidden="true" className="size-4" />
                </Button>
              </div>
            ))}
            <div>
              <Button
                icon={<Plus aria-hidden="true" className="size-4" />}
                disabled={form.values.middlewares.length >= 20}
                onClick={() => form.set("middlewares", [...form.values.middlewares, ""])}
              >
                {t("dialog.addMiddleware")}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="ssl" className="grid gap-4 pt-4">
            <Field
              label={t("dialog.resolver")}
              hint={t("dialog.resolverHint")}
              optional
              error={errors.certificateResolver}
            >
              <Input
                {...form.field("certificateResolver")}
                mono
                placeholder={t("dialog.resolverPlaceholder")}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
              />
            </Field>
            <Switch
              label={t("dialog.wildcard")}
              hint={t("dialog.wildcardHint")}
              checked={form.values.wildcard}
              onCheckedChange={(checked) => form.set("wildcard", checked)}
            />
          </TabsContent>
        </Tabs>
      </div>
    </Dialog>
  );
}

export function DomainDialog({ open, ...props }: DomainDialogProps) {
  // The form only exists while the dialog is open, so it always starts from the current values.
  return open ? <DomainForm {...props} /> : null;
}
