import type { OverviewDomain } from "@opsifier/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "../../lib/forms";
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
  Segmented,
  Select,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "../../ui";
import { projectsQuery } from "../projects/api";
import { exposedPortsQuery } from "../services/tabs/domains/api";
import { domainsOverviewKey, overviewApi } from "./api";
import { DomainPrerequisites, UpstreamCertificateFields } from "./DomainPrerequisites";

type Destination = "service" | "custom";

interface ServerRow {
  /** Only identifies the row while the form is open. */
  key: number;
  url: string;
  weight: string;
}

interface MiddlewareRow {
  key: number;
  name: string;
}

let nextRowKey = 0;
const rowKey = () => {
  nextRowKey += 1;
  return nextRowKey;
};

const blankServer = (): ServerRow => ({ key: rowKey(), url: "", weight: "1" });

interface FormValues {
  https: boolean;
  host: string;
  path: string;
  stripPath: boolean;
  project: string;
  service: string;
  protocol: "http" | "https";
  port: string;
  destinationPath: string;
  upstreamServerName: string;
  upstreamCa: string;
  certificateResolver: string;
  wildcard: boolean;
  [key: string]: unknown;
}

const emptyValues: FormValues = {
  https: true,
  host: "",
  path: "/",
  stripPath: false,
  project: "",
  service: "",
  protocol: "http",
  port: "80",
  destinationPath: "/",
  upstreamServerName: "",
  upstreamCa: "",
  certificateResolver: "",
  wildcard: false,
};

function valuesOf(domain: OverviewDomain | null): FormValues {
  if (domain === null) {
    return emptyValues;
  }
  if (domain.destination === "custom") {
    return {
      ...emptyValues,
      https: domain.https,
      host: domain.host,
      path: domain.path,
      stripPath: domain.stripPath,
      certificateResolver: domain.certificateResolver ?? "",
      wildcard: domain.wildcard,
    };
  }
  return {
    https: domain.https,
    host: domain.host,
    path: domain.path,
    stripPath: domain.stripPath,
    project: domain.projectName,
    service: domain.serviceName,
    protocol: domain.destinationProtocol,
    port: String(domain.port),
    destinationPath: domain.destinationPath,
    upstreamServerName: domain.upstreamServerName ?? "",
    upstreamCa: domain.upstreamCa ?? "",
    certificateResolver: domain.certificateResolver ?? "",
    wildcard: domain.wildcard,
  };
}

/** What the service's image declares, for filling in the port. */
function PortSuggestions({
  project,
  service,
  onPick,
}: {
  project: string;
  service: string;
  onPick: (port: number) => void;
}) {
  const { t } = useTranslation("domains");
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    ...exposedPortsQuery(project, service),
    enabled: open && service !== "",
  });
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" disabled={service === ""} aria-label={t("form.suggest")}>
          {t("form.suggest")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(data?.ports ?? []).length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted">{t("form.noSuggestions")}</div>
        ) : (
          data?.ports.map((port) => (
            <DropdownMenuItem key={port} onSelect={() => onPick(port)}>
              <span className="font-mono text-xs">{port}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface DomainFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null to create a domain. */
  domain: OverviewDomain | null;
  serverIp: string | null;
  canManageCustom: boolean;
  /** Null when every project can be changed. */
  managedProjects: readonly string[] | null;
}

/** Create or change a domain: where it answers, where it goes, and how its traffic is handled. */
export function DomainFormDialog({
  open,
  onOpenChange,
  domain,
  serverIp,
  canManageCustom,
  managedProjects,
}: DomainFormDialogProps) {
  const { t } = useTranslation(["domains", "common"]);
  const queryClient = useQueryClient();
  const { data: projects } = useQuery({ ...projectsQuery, enabled: open });
  const [destination, setDestination] = useState<Destination>("service");
  const [servers, setServers] = useState<ServerRow[]>([blankServer()]);
  const [middlewares, setMiddlewares] = useState<MiddlewareRow[]>([]);
  const [tab, setTab] = useState("details");

  const form = useForm<FormValues>({
    t,
    initialValues: emptyValues,
    validate: (values) => {
      const errors: Partial<Record<string, string>> = {};
      if (values.host.trim() === "") {
        errors.host = t("errors.host");
      }
      if (destination === "service" && (values.project === "" || values.service === "")) {
        errors.project = t("errors.service");
      }
      return errors;
    },
    onSubmit: async (values) => {
      const shared = {
        host: values.host,
        path: values.path,
        stripPath: values.stripPath,
        https: values.https,
        certificateResolver: values.certificateResolver === "" ? null : values.certificateResolver,
        wildcard: values.wildcard,
        middlewares: middlewares.map((row) => row.name).filter((name) => name.trim() !== ""),
      };
      if (destination === "custom") {
        const body = {
          ...shared,
          servers: servers.map((server) => ({ url: server.url, weight: Number(server.weight) || 1 })),
        };
        await (domain?.destination === "custom"
          ? overviewApi.updateCustom(domain.id, body)
          : overviewApi.createCustom(body));
      } else {
        const body = {
          ...shared,
          port: Number(values.port) || 80,
          destinationProtocol: values.protocol,
          destinationPath: values.destinationPath,
          upstreamServerName: values.upstreamServerName === "" ? null : values.upstreamServerName,
          upstreamCa: values.upstreamCa === "" ? null : values.upstreamCa,
        };
        await (domain?.destination === "service"
          ? overviewApi.updateService(values.project, values.service, domain.id, body)
          : overviewApi.createService(values.project, values.service, body));
      }
      await queryClient.invalidateQueries({ queryKey: domainsOverviewKey });
      toast.success(t(domain === null ? "created" : "updated"));
      onOpenChange(false);
    },
  });
  const { reset } = form;

  useEffect(() => {
    if (open) {
      reset(valuesOf(domain));
      setDestination(domain?.destination ?? "service");
      setServers(
        domain?.destination === "custom"
          ? domain.servers.map((server) => ({
              key: rowKey(),
              url: server.url,
              weight: String(server.weight),
            }))
          : [blankServer()],
      );
      setMiddlewares(domain === null ? [] : domain.middlewares.map((name) => ({ key: rowKey(), name })));
      setTab("details");
    }
  }, [open, domain, reset]);

  const projectOptions = (projects?.projects ?? [])
    .filter((project) => managedProjects === null || managedProjects.includes(project.name))
    .map((project) => ({
      value: project.name,
      label: project.name,
    }));
  const serviceOptions = useMemo(
    () =>
      (projects?.projects.find((project) => project.name === form.values.project)?.services ?? []).map(
        (service) => ({
          value: service.name,
          label: service.name,
        }),
      ),
    [projects, form.values.project],
  );

  const updateServer = (key: number, changes: Partial<ServerRow>) =>
    setServers((rows) => rows.map((row) => (row.key === key ? { ...row, ...changes } : row)));
  const updateMiddleware = (key: number, name: string) =>
    setMiddlewares((rows) => rows.map((row) => (row.key === key ? { ...row, name } : row)));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(domain === null ? "form.createTitle" : "form.editTitle")}
      size="lg"
      onSubmit={form.handleSubmit}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" variant="primary" pending={form.pending}>
            {t(domain === null ? "form.create" : "form.save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {form.banner && <FormBanner>{form.banner}</FormBanner>}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="details">{t("form.tabs.details")}</TabsTrigger>
            <TabsTrigger value="middlewares">{t("form.tabs.middlewares")}</TabsTrigger>
            <TabsTrigger value="ssl">{t("form.tabs.ssl")}</TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="grid gap-4 pt-4">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <Field label={t("form.host")} hint={t("form.hostHint")} error={form.errors.host}>
                <Input
                  {...form.field("host")}
                  mono
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="app.example.com"
                />
              </Field>
              <Switch
                label={t("form.https")}
                hint={t("form.httpsHint")}
                checked={form.values.https}
                onCheckedChange={(checked) => form.set("https", checked)}
              />
            </div>
            <Field label={t("form.path")} error={form.errors.path} hint={t("form.pathHint")}>
              <Input {...form.field("path")} mono />
            </Field>
            <Switch
              label={t("form.stripPath")}
              hint={t("form.stripPathHint")}
              checked={form.values.stripPath}
              onCheckedChange={(checked) => form.set("stripPath", checked)}
            />
            <DomainPrerequisites
              host={form.values.host}
              wildcard={form.values.wildcard}
              https={form.values.https}
              serverIp={serverIp}
            />
            {canManageCustom && (
              <Field label={t("form.destination")} hint={t("form.destinationHint")}>
                <Segmented
                  label={t("form.destination")}
                  value={destination}
                  onChange={setDestination}
                  options={[
                    { value: "service", label: t("form.service") },
                    { value: "custom", label: t("form.custom") },
                  ]}
                />
              </Field>
            )}
            {destination === "service" ? (
              <div className="grid gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("form.project")} error={form.errors.project} hint={t("form.projectHint")}>
                    <Select
                      value={form.values.project}
                      onValueChange={(value) => {
                        form.set("project", value);
                        form.set("service", "");
                      }}
                      options={projectOptions}
                      placeholder={t("form.choose")}
                    />
                  </Field>
                  <Field
                    label={t("form.service")}
                    hint={form.values.project === "" ? t("form.chooseProjectFirst") : undefined}
                  >
                    <Select
                      value={form.values.service}
                      onValueChange={(value) => form.set("service", value)}
                      options={serviceOptions}
                      placeholder={t("form.choose")}
                      disabled={form.values.project === ""}
                    />
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label={t("form.protocol")} hint={t("form.protocolHint")}>
                    <Select
                      value={form.values.protocol}
                      onValueChange={(value) => form.set("protocol", value as FormValues["protocol"])}
                      options={[
                        { value: "http", label: "HTTP" },
                        { value: "https", label: "HTTPS" },
                      ]}
                    />
                  </Field>
                  <Field label={t("form.port")} error={form.errors.port} hint={t("form.portHint")}>
                    <div className="flex items-center gap-1.5">
                      <Input {...form.field("port")} mono inputMode="numeric" />
                      <PortSuggestions
                        project={form.values.project}
                        service={form.values.service}
                        onPick={(port) => form.set("port", String(port))}
                      />
                    </div>
                  </Field>
                  <Field
                    label={t("form.internalPath")}
                    error={form.errors.destinationPath}
                    hint={t("form.internalPathHint")}
                  >
                    <Input {...form.field("destinationPath")} mono />
                  </Field>
                </div>
                {form.values.protocol === "https" && (
                  <UpstreamCertificateFields
                    serverName={form.field("upstreamServerName")}
                    certificates={form.field("upstreamCa")}
                    serverNameError={form.errors.upstreamServerName}
                    certificatesError={form.errors.upstreamCa}
                  />
                )}
              </div>
            ) : (
              <fieldset className="grid gap-2">
                <legend className="sr-only">{t("form.servers")}</legend>
                {servers.map((server, index) => (
                  <div key={server.key} className="flex items-end gap-2">
                    <Field
                      label={`${index + 1} / ${t("form.serverUrl")}`}
                      className="min-w-0 flex-1"
                      hint={t("form.serverUrlHint")}
                    >
                      <Input
                        mono
                        value={server.url}
                        onChange={(event) => updateServer(server.key, { url: event.currentTarget.value })}
                        placeholder="https://example.com"
                      />
                    </Field>
                    <Field label={t("form.weight")} className="w-20" hint={t("form.weightHint")}>
                      <Input
                        mono
                        inputMode="numeric"
                        value={server.weight}
                        onChange={(event) => updateServer(server.key, { weight: event.currentTarget.value })}
                      />
                    </Field>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("form.removeServer")}
                      disabledReason={servers.length === 1 ? t("form.lastServer") : undefined}
                      onClick={() => setServers((rows) => rows.filter((row) => row.key !== server.key))}
                    >
                      <X aria-hidden="true" className="size-4" />
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    icon={<Plus aria-hidden="true" className="size-4" />}
                    onClick={() => setServers((rows) => [...rows, blankServer()])}
                  >
                    {t("form.addServer")}
                  </Button>
                </div>
              </fieldset>
            )}
          </TabsContent>
          <TabsContent value="middlewares" className="grid gap-2 pt-4">
            {middlewares.map((row, index) => (
              <div key={row.key} className="flex items-center gap-2">
                <Input
                  mono
                  aria-label={t("form.middleware", { index: index + 1 })}
                  value={row.name}
                  onChange={(event) => updateMiddleware(row.key, event.currentTarget.value)}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("form.removeMiddleware")}
                  onClick={() =>
                    setMiddlewares((rows) => rows.filter((candidate) => candidate.key !== row.key))
                  }
                >
                  <X aria-hidden="true" className="size-4" />
                </Button>
              </div>
            ))}
            <div>
              <Button
                icon={<Plus aria-hidden="true" className="size-4" />}
                onClick={() => setMiddlewares((rows) => [...rows, { key: rowKey(), name: "" }])}
              >
                {t("form.addMiddleware")}
              </Button>
            </div>
          </TabsContent>
          <TabsContent value="ssl" className="grid gap-4 pt-4">
            <Field
              label={t("form.resolver")}
              error={form.errors.certificateResolver}
              hint={t("form.resolverHint")}
            >
              <Input {...form.field("certificateResolver")} mono placeholder="letsencrypt" />
            </Field>
            <Switch
              label={t("form.wildcard")}
              hint={t("form.wildcardHint")}
              checked={form.values.wildcard}
              onCheckedChange={(checked) => form.set("wildcard", checked)}
            />
            {form.values.wildcard && form.values.https && (
              <FormBanner tone="warning">{t("form.wildcardUnverified")}</FormBanner>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </Dialog>
  );
}
