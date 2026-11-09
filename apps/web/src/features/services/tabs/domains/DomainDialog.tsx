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
import { DomainPrerequisites, UpstreamCertificateFields } from "../../../domains/DomainPrerequisites";
import { domainsApi, domainTlsQuery, exposedPortsQuery } from "./api";

interface DomainFormValues {
  https: boolean;
  host: string;
  path: string;
  stripPath: boolean;
  destinationProtocol: "http" | "https";
  port: string;
  destinationPath: string;
  upstreamServerName: string;
  upstreamCa: string;
  certificateResolver: string;
  wildcard: boolean;
  middlewares: string[];
  composeService: string;
  [key: string]: unknown;
}

type Name = "details" | "middlewares" | "ssl";

const tabOfField: Record<string, Name> = {
  host: "details",
  path: "details",
  port: "details",
  destinationPath: "details",
  destinationProtocol: "details",
  upstreamServerName: "details",
  upstreamCa: "details",
  https: "details",
  middlewares: "middlewares",
  certificateResolver: "ssl",
  wildcard: "ssl",
};

const blank: DomainFormValues = {
  https: true,
  host: "",
  path: "/",
  stripPath: false,
  destinationProtocol: "http",
  port: "80",
  destinationPath: "/",
  upstreamServerName: "",
  upstreamCa: "",
  certificateResolver: "",
  wildcard: false,
  middlewares: [],
  composeService: "",
};

const valuesFrom = (domain: DomainEntry): DomainFormValues => ({
  https: domain.https,
  host: domain.host,
  path: domain.path,
  stripPath: domain.stripPath,
  destinationProtocol: domain.destinationProtocol,
  port: String(domain.port),
  destinationPath: domain.destinationPath,
  upstreamServerName: domain.upstreamServerName ?? "",
  upstreamCa: domain.upstreamCa ?? "",
  certificateResolver: domain.certificateResolver ?? "",
  wildcard: domain.wildcard,
  middlewares: domain.middlewares,
  composeService: domain.composeService ?? "",
});

const toRequest = (values: DomainFormValues): SaveDomainRequest => ({
  https: values.https,
  host: values.host,
  path: values.path,
  stripPath: values.stripPath,
  destinationProtocol: values.destinationProtocol,
  port: values.port.trim() === "" ? Number.NaN : Number(values.port),
  destinationPath: values.destinationPath,
  upstreamServerName: values.upstreamServerName === "" ? null : values.upstreamServerName,
  upstreamCa: values.upstreamCa === "" ? null : values.upstreamCa,
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
      <DropdownMenuContent className="min-w-[180px]">
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
  /** For a Compose stack: the children a domain can reach. */
  composeServices?: readonly string[];
}

const COMPOSE_NONE = "__none__";

function DomainForm({
  project,
  service,
  domain,
  onOpenChange,
  onSaved,
  composeServices,
}: Omit<DomainDialogProps, "open">) {
  const { t } = useTranslation(["service-domains", "common", "compose"]);
  const [tab, setTab] = useState<Name>("details");
  // Only for the DNS record's value: a member who can't read it still sees what has to be done.
  const { data: overview } = useQuery(domainTlsQuery);
  const form = useForm<DomainFormValues>({
    t,
    initialValues: domain === undefined ? blank : valuesFrom(domain),
    validate: (values) => {
      const errors = schemaErrors<string>(saveDomainRequest, toRequest(values), {
        host: t("errors.host"),
        path: t("errors.path"),
        port: t("errors.port"),
        destinationPath: t("errors.destinationPath"),
        upstreamServerName: t("errors.upstreamServerName"),
        upstreamCa: t("errors.upstreamCa"),
        certificateResolver: t("errors.resolver"),
        middlewares: t("errors.middlewares"),
      }) as FieldErrors<keyof DomainFormValues & string>;
      if (errors.certificateResolver !== undefined && values.certificateResolver.trim() === "") {
        errors.certificateResolver = t("errors.resolverRequired");
      }
      return errors;
    },
    onSubmit: async (values) => {
      const request = {
        ...toRequest(values),
        ...(composeServices === undefined ? {} : { composeService: values.composeService }),
      };
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

  const detailsFields = [
    "host",
    "path",
    "port",
    "destinationPath",
    "destinationProtocol",
    "upstreamServerName",
    "upstreamCa",
  ];

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
            <Field label={t("dialog.host")} error={errors.host} hint={t("dialog.hostHint")}>
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
            <Switch
              label={t("dialog.stripPath")}
              hint={t("dialog.stripPathHint")}
              checked={form.values.stripPath}
              onCheckedChange={(checked) => form.set("stripPath", checked)}
            />
            <DomainPrerequisites
              host={form.values.host}
              wildcard={form.values.wildcard}
              https={form.values.https}
              serverIp={overview?.serverIp ?? null}
            />
            <fieldset className="m-0 grid gap-4 border-0 p-0">
              <legend className="eyebrow mb-1">{t("dialog.destination")}</legend>
              {composeServices !== undefined && (
                <Field
                  label={t("compose:domains.child")}
                  error={errors.composeService}
                  hint={t("compose:domains.childHint")}
                >
                  <Select
                    value={form.values.composeService === "" ? COMPOSE_NONE : form.values.composeService}
                    onValueChange={(value) => form.set("composeService", value === COMPOSE_NONE ? "" : value)}
                    options={[
                      { value: COMPOSE_NONE, label: t("compose:domains.none") },
                      ...composeServices.map((name) => ({ value: name, label: name })),
                    ]}
                  />
                </Field>
              )}
              <div className="grid items-start gap-3 sm:grid-cols-[120px_minmax(0,1fr)]">
                <Field
                  label={t("dialog.protocol")}
                  error={errors.destinationProtocol}
                  hint={t("dialog.protocolHint")}
                >
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
              {form.values.destinationProtocol === "https" && (
                <UpstreamCertificateFields
                  serverName={form.field("upstreamServerName")}
                  certificates={form.field("upstreamCa")}
                  serverNameError={errors.upstreamServerName}
                  certificatesError={errors.upstreamCa}
                />
              )}
            </fieldset>
          </TabsContent>

          <TabsContent value="middlewares" className="grid gap-3 pt-4">
            <p className="text-sm text-muted">{t("dialog.middlewaresHint")}</p>
            {errors.middlewares && <FormBanner>{errors.middlewares}</FormBanner>}
            {form.values.middlewares.map((name, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
              <div key={index} className="flex items-end gap-2">
                <Field
                  label={t("dialog.middleware", { number: index + 1 })}
                  className="min-w-0 flex-1"
                  hint={t("dialog.middlewareHint")}
                >
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
                disabledReason={form.values.middlewares.length >= 20 ? t("dialog.maxMiddlewares") : undefined}
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
            {form.values.wildcard && form.values.https && (
              <FormBanner tone="warning">{t("dialog.wildcardUnverified")}</FormBanner>
            )}
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
