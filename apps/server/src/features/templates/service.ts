import { randomBytes, randomInt } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  databaseEngineInfo,
  type InstallTemplateRequest,
  installTemplateRequest,
  type MountSpec,
  type PortSpec,
  requiresHostAccess,
  type ServiceSummary,
  type TemplateComponent,
  type TemplateDocument,
  type TemplateInstall,
  type TemplateInstallList,
  type TemplateParam,
  type TemplateService,
  templateActionTypes,
  templateDeployOrder,
  templateDocument,
  usesEnvPlaceholders,
} from "@opsifier/contract";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { ActionRow } from "../../core/actions";
import type { AppDeps } from "../../core/context";
import { actions, templateInstalls } from "../../core/db/schema";
import { AppError, badRequest, conflict, notFound } from "../../core/errors";
import { hashCompose, writeInlineCompose } from "../compose/deploy";
import { hasBlockingError, hasHostAccess } from "../compose/inspect";
import { assertComposeNameFree, inspectStackFile } from "../compose/service";
import { prepareDatabaseSpec } from "../databases/service";
import { assignDefaultDomain, defaultBaseDomain, primaryUrl } from "../service-tabs/domains/service";
import { sealEnv } from "../services/env-store";
import { enqueueDeploy, enqueueDestroy, removeServiceEverywhere } from "../services/lifecycle";
import { assertNameFreeInDocker } from "../services/ownership";
import {
  findService,
  insertService,
  listServiceRecords,
  type ServiceRecord,
  saveServiceSpec,
} from "../services/repo";
import {
  assertAddressFree,
  assertNameFits,
  assertRoomForServices,
  requireProject,
  type ServiceTarget,
  serviceDir,
  writeProxyConfig,
} from "../services/service";
import { type AppServiceSpec, appServiceSpec } from "../services/spec";
import { indexActiveActions, readLiveState, summarize } from "../services/status";
import { catalogueTemplates } from "./catalogue";
import {
  type RenderInput,
  referencesOf,
  renderEnv,
  renderInstructions,
  renderText,
  resolveParam,
  type ServiceIdentity,
} from "./render";
import { TEMPLATE_SECRET_CONTEXT } from "./spec";

const ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Random with no special characters, so a value is safe in a URL and a shell without any quoting. */
function generateSecret(length: number, alphabet: "alphanumeric" | "hex"): string {
  if (alphabet === "hex") {
    return randomBytes(Math.ceil(length / 2))
      .toString("hex")
      .slice(0, length);
  }
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += ALPHANUMERIC[randomInt(ALPHANUMERIC.length)];
  }
  return value;
}

export function listCatalogue(deps: Pick<AppDeps, "logger">): { templates: TemplateDocument[] } {
  return { templates: [...catalogueTemplates(deps.logger)] };
}

/** Reads a pasted document. A problem is reported on the field, in the parser's own terms. */
export function parseTemplateSchema(schema: string): TemplateDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(schema);
  } catch (error) {
    throw badRequest("invalid_schema", "This is not valid JSON.", {
      schema: error instanceof Error ? error.message : "Not valid JSON",
    });
  }
  const result = templateDocument.safeParse(parsed);
  if (!result.success) {
    const [issue] = result.error.issues;
    throw badRequest("invalid_schema", "This template is not valid.", {
      schema: `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}`.replace(/^: /, ""),
    });
  }
  return result.data;
}

function chooseDocument(deps: Pick<AppDeps, "logger">, source: InstallFields["source"]): TemplateDocument {
  if (source.type === "schema") {
    return parseTemplateSchema(source.schema);
  }
  const found = catalogueTemplates(deps.logger).find((template) => template.id === source.id);
  if (found === undefined) {
    throw notFound("This template is not in the catalogue.");
  }
  return found;
}

type InstallFields = ReturnType<typeof installTemplateRequest.parse>;

interface ResolvedForm {
  /** Plain values, by key. */
  params: Record<string, string>;
  /** Sealed values to store, by key, with what the install page should call them. */
  secrets: Map<string, { value: string; label: TemplateDocument["secrets"][number]["label"] | null }>;
  names: Map<string, string>;
  images: Map<string, string>;
  existing: Map<string, ServiceRecord>;
}

function fieldError(fields: Record<string, string>): void {
  if (Object.keys(fields).length > 0) {
    throw badRequest("validation_failed", "Some fields need attention.", fields);
  }
}

function resolveParams(
  document: TemplateDocument,
  values: InstallFields["params"],
): {
  params: Record<string, string>;
  secrets: ResolvedForm["secrets"];
  fields: Record<string, string>;
} {
  const params: Record<string, string> = {};
  const secrets: ResolvedForm["secrets"] = new Map();
  const fields: Record<string, string> = {};

  for (const param of document.params) {
    const raw = values[param.key];
    if (param.type === "secret") {
      const typed = typeof raw === "string" ? raw : "";
      if (typed === "" && param.generate === undefined && param.required) {
        fields[`params.${param.key}`] = "Required";
        continue;
      }
      if (typed !== "" || param.generate !== undefined) {
        secrets.set(param.key, {
          value:
            typed !== ""
              ? typed
              : generateSecret(param.generate?.length ?? 32, param.generate?.alphabet ?? "alphanumeric"),
          label: param.label,
        });
      }
      continue;
    }
    const { value, problem } = resolveParam(param as TemplateParam, raw ?? param.default);
    if (problem !== null) {
      fields[`params.${param.key}`] = problem;
    } else {
      params[param.key] = value;
    }
  }

  for (const secret of document.secrets) {
    secrets.set(secret.key, {
      value: generateSecret(secret.length, secret.alphabet),
      label: secret.label ?? null,
    });
  }
  return { params, secrets, fields };
}

function resolveServices(
  deps: Pick<AppDeps, "db">,
  project: string,
  document: TemplateDocument,
  input: InstallFields["services"],
): Pick<ResolvedForm, "names" | "images" | "existing"> & { fields: Record<string, string> } {
  const names = new Map<string, string>();
  const images = new Map<string, string>();
  const existing = new Map<string, ServiceRecord>();
  const fields: Record<string, string> = {};
  const chosen = new Map<string, string>();

  for (const service of document.services) {
    const value = input[service.key];
    if (value === undefined) {
      fields[`services.${service.key}.name`] = "Required";
      continue;
    }

    if (service.kind === "database" && value.existing !== null) {
      const record = findService(deps.db, project, value.existing);
      if (record?.spec.database?.engine !== service.engine) {
        fields[`services.${service.key}.existing`] =
          record === undefined
            ? "This database does not exist in this project"
            : `Choose a ${service.engine} database`;
      } else {
        existing.set(service.key, record);
        names.set(service.key, record.name);
      }
      continue;
    }

    const previous = chosen.get(value.name);
    if (previous !== undefined) {
      fields[`services.${service.key}.name`] = `Already used by ${previous}`;
      continue;
    }
    chosen.set(value.name, service.key);
    if (findService(deps.db, project, value.name) !== undefined) {
      fields[`services.${service.key}.name`] = "This name is taken in this project";
    } else {
      try {
        assertNameFits(project, value.name);
        assertAddressFree(deps, { projectName: project, serviceName: value.name });
      } catch (error) {
        fields[`services.${service.key}.name`] =
          error instanceof AppError && error.code === "address_taken"
            ? "Another service already answers to this name"
            : "Too long together with the project name";
      }
    }
    names.set(service.key, value.name);

    if (service.kind !== "compose") {
      const image =
        value.image ??
        (service.kind === "database"
          ? service.image
          : service.source.type === "image"
            ? service.source.image
            : undefined);
      if (image !== undefined) {
        images.set(service.key, image);
      }
    }
  }
  return { names, images, existing, fields };
}

function assertHostAccessConfirmed(
  deps: Pick<AppDeps, "config" | "db">,
  project: string,
  document: TemplateDocument,
  confirmed: boolean,
): void {
  const composeReaches = document.services.some((service) => {
    if (service.kind !== "compose") {
      return false;
    }
    // Names of files and hosts inside the document are placeholders until rendering: a token never
    // changes whether a mount reaches the host, so reading it as written gives the right answer.
    const inspection = inspectStackFile(
      deps,
      { projectName: project, serviceName: service.name },
      service.file,
    );
    if (hasBlockingError(inspection)) {
      throw badRequest("validation_failed", "Some fields need attention.", {
        [`services.${service.key}.name`]: "The Compose file of this service can't run",
      });
    }
    return hasHostAccess(inspection);
  });
  if ((requiresHostAccess(document) || composeReaches) && !confirmed) {
    throw badRequest(
      "host_access_not_confirmed",
      "This template can control the server. Confirm this to continue.",
      {
        acknowledgeHostAccess: "Confirm that this template may control the server",
      },
    );
  }
}

const servicePortRange = (published: unknown): number | null => {
  const port = Number(published);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
};

/** Each new name, against what Docker holds. Compose goes by project name, the rest by Swarm service. */
async function assertNamesFreeInDocker(
  deps: AppDeps,
  project: string,
  planned: readonly PlannedService[],
  existing: ReadonlyMap<string, ServiceRecord>,
): Promise<void> {
  const fields: Record<string, string> = {};
  for (const { service, name } of planned) {
    if (existing.has(service.key)) {
      continue;
    }
    const target = { projectName: project, serviceName: name };
    try {
      await (service.kind === "compose"
        ? assertComposeNameFree(deps, target)
        : assertNameFreeInDocker(deps, target));
    } catch (error) {
      if (!(error instanceof AppError && error.code === "service_not_owned")) {
        throw error;
      }
      fields[`services.${service.key}.name`] = "Docker already runs something under this name";
    }
  }
  fieldError(fields);
}

interface PlannedService {
  service: TemplateService;
  name: string;
}

function identityBase(
  service: TemplateService,
  name: string,
  record: ServiceRecord | undefined,
): ServiceIdentity {
  if (service.kind === "database") {
    const info = databaseEngineInfo[service.engine];
    return {
      kind: "database",
      name,
      domain: null,
      https: false,
      database: {
        port: info.port,
        user: record?.spec.database?.user ?? service.user ?? info.defaultUser,
        databaseName: info.hasDatabaseName
          ? record !== undefined
            ? (record.spec.database?.databaseName ?? null)
            : (service.databaseName ?? null)
          : null,
      },
    };
  }
  return { kind: service.kind, name, domain: null, https: service.domain?.https ?? true, database: null };
}

/** The mounts of an app, with what the file form asks for. Socket access is confirmed at the form. */
function appMounts(service: Extract<TemplateService, { kind: "app" }>, input: RenderInput): MountSpec[] {
  return service.mounts.map((mount) => {
    if (mount.type === "volume") {
      return { type: "volume", name: mount.name, mountPath: mount.path };
    }
    if (mount.type === "file") {
      return { type: "file", mountPath: mount.path, content: renderText(mount.content, input) };
    }
    return {
      type: "bind",
      hostPath: "/var/run/docker.sock",
      mountPath: mount.path,
      acknowledgeRisk: true,
    };
  });
}

function appPorts(
  service: Extract<TemplateService, { kind: "app" }>,
  params: Readonly<Record<string, string>>,
  fields: Record<string, string>,
): PortSpec[] {
  const ports: PortSpec[] = [];
  for (const port of service.ports) {
    const published =
      typeof port.published === "number"
        ? port.published
        : servicePortRange(params[port.published.replace(/[{}\s]|params\./g, "")]);
    if (published === null) {
      fields[`services.${service.key}.name`] = `The published port of ${service.name} is not valid`;
      continue;
    }
    ports.push({ protocol: port.protocol, published, target: port.target });
  }
  return ports;
}

/** One service's spec, once every name it refers to is known. */
function buildSpec(
  deps: Pick<AppDeps, "secrets">,
  service: Exclude<TemplateService, { kind: "database" }>,
  input: RenderInput,
  form: ResolvedForm,
  installId: string,
  fields: Record<string, string>,
): AppServiceSpec {
  const env = renderEnv(service.env, input, service.key);
  const references = referencesOf(Object.values(service.env));
  const secrets: Record<
    string,
    { sealed: string; label: TemplateDocument["secrets"][number]["label"] | null }
  > = {};
  for (const reference of references.secrets) {
    const key = reference.startsWith("param:") ? reference.slice("param:".length) : reference;
    const secret = form.secrets.get(key);
    if (secret !== undefined) {
      secrets[key] = {
        sealed: deps.secrets.seal(secret.value, TEMPLATE_SECRET_CONTEXT),
        label: secret.label,
      };
    }
  }
  const databases = Object.fromEntries(
    [...references.databases]
      .filter((key) => input.services.get(key)?.database != null)
      .map((key) => [key, { service: input.services.get(key)?.name ?? "" }]),
  );
  const shared = {
    sealedEnv: sealEnv(deps, env),
    // A document that names one of these placeholders depends on them being filled in.
    envInterpolation: usesEnvPlaceholders(env),
    references: { secrets, databases },
    template: { installId, role: service.key, kind: service.kind },
  };

  if (service.kind === "compose") {
    return appServiceSpec.parse({
      ...shared,
      compose: { source: { type: "inline", content: renderText(service.file, input) } },
    });
  }

  const mounts = appMounts(service, input);
  const stateful = mounts.some((mount) => mount.type === "volume");
  const source =
    service.source.type === "image"
      ? {
          type: "image" as const,
          image: form.images.get(service.key) ?? service.source.image,
          username: null,
          sealedPassword: null,
        }
      : {
          type: "git" as const,
          url: service.source.url,
          ref: service.source.ref,
          path: service.source.path,
          webhookId: null,
        };

  return appServiceSpec.parse({
    ...shared,
    source,
    build: service.source.type === "git" ? { config: service.source.build } : {},
    deploy: {
      replicas: 1,
      // Two tasks must never share a volume through a rolling update of a single-node application.
      zeroDowntime: !stateful,
      command: service.command === null ? null : renderText(service.command, input),
    },
    mounts,
    ports: appPorts(service, input.params, fields),
  });
}

function toInstallRow(
  id: string,
  project: string,
  document: TemplateDocument,
  custom: boolean,
  instructions: RenderInput,
  now: Date,
) {
  return {
    id,
    projectName: project,
    templateId: document.id,
    templateVersion: document.version,
    templateName: document.name,
    category: document.category,
    custom,
    instructions: renderInstructions(instructions),
    createdAt: now,
  };
}

function serviceRows(deps: Pick<AppDeps, "db">, project: string, id: string): ServiceRecord[] {
  return listServiceRecords(deps.db, project).filter((record) => record.spec.template?.installId === id);
}

type InstallRow = typeof templateInstalls.$inferSelect;

function toInstall(
  deps: AppDeps,
  row: InstallRow,
  records: readonly ServiceRecord[],
  live: Awaited<ReturnType<typeof readLiveState>>,
  active: ReturnType<typeof indexActiveActions>,
): TemplateInstall {
  const components: TemplateComponent[] = orderRecords(records).map((record) => ({
    role: record.spec.template?.role ?? record.name,
    kind: record.spec.template?.kind ?? "app",
    service: summarize(deps, record, live, active) as ServiceSummary,
    url: primaryUrl(deps.db, { projectName: record.projectName, serviceName: record.name }),
  }));
  return {
    id: row.id,
    projectName: row.projectName,
    templateId: row.templateId,
    templateVersion: row.templateVersion,
    templateName: row.templateName,
    category: row.category as TemplateInstall["category"],
    custom: row.custom,
    createdAt: row.createdAt.toISOString(),
    instructions: row.instructions,
    components,
    secrets: records.flatMap((record) =>
      Object.entries(record.spec.references.secrets)
        .filter(([, secret]) => secret.label !== null)
        .map(([name, secret]) => ({ service: record.name, name, label: secret.label })),
    ),
  };
}

export async function listInstalls(deps: AppDeps, project: string): Promise<TemplateInstallList> {
  requireProject(deps, project);
  const rows = deps.db.select().from(templateInstalls).where(eq(templateInstalls.projectName, project)).all();
  if (rows.length === 0) {
    return { installs: [] };
  }
  const live = await readLiveState(deps);
  const active = indexActiveActions(deps);
  return {
    installs: rows.flatMap((row) => {
      const records = serviceRows(deps, project, row.id);
      return records.length === 0 ? [] : [toInstall(deps, row, records, live, active)];
    }),
  };
}

function requireInstall(deps: Pick<AppDeps, "db">, project: string, id: string): InstallRow {
  const row = deps.db
    .select()
    .from(templateInstalls)
    .where(and(eq(templateInstalls.id, id), eq(templateInstalls.projectName, project)))
    .get();
  if (row === undefined) {
    throw notFound("This install does not exist.");
  }
  return row;
}

export async function getInstall(deps: AppDeps, project: string, id: string): Promise<TemplateInstall> {
  const row = requireInstall(deps, project, id);
  const records = serviceRows(deps, project, id);
  return toInstall(deps, row, records, await readLiveState(deps), indexActiveActions(deps));
}

/**
 * Turns a document and a form into stored services. Nothing is deployed: this is configuration, and
 * running it is a separate step someone takes on purpose. Every name, address and secret is decided
 * inside one transaction, so a failure leaves nothing behind.
 */
export async function installTemplate(
  deps: AppDeps,
  project: string,
  request: InstallTemplateRequest,
  actorEmail: string | undefined,
): Promise<TemplateInstall> {
  requireProject(deps, project);
  const fieldsInput = installTemplateRequest.parse(request);
  const document = chooseDocument(deps, fieldsInput.source);

  const resolvedParams = resolveParams(document, fieldsInput.params);
  const resolvedServices = resolveServices(deps, project, document, fieldsInput.services);
  fieldError({ ...resolvedParams.fields, ...resolvedServices.fields });
  assertHostAccessConfirmed(deps, project, document, fieldsInput.acknowledgeHostAccess);

  const form: ResolvedForm = {
    params: resolvedParams.params,
    secrets: resolvedParams.secrets,
    names: resolvedServices.names,
    images: resolvedServices.images,
    existing: resolvedServices.existing,
  };

  const ordered = templateDeployOrder(document.services);
  const planned: PlannedService[] = ordered.map((service) => ({
    service,
    name: form.names.get(service.key) ?? service.name,
  }));
  assertRoomForServices(
    deps,
    project,
    planned.filter(({ service }) => !form.existing.has(service.key)).length,
  );
  await assertNamesFreeInDocker(deps, project, planned, form.existing);

  // Everything that needs Docker is done first, because the transaction below can't wait for anything.
  const databaseSpecs = new Map<string, AppServiceSpec>();
  for (const { service, name } of planned) {
    if (service.kind === "database" && !form.existing.has(service.key)) {
      const fields = { name, engine: service.engine, databaseName: service.databaseName, user: service.user };
      databaseSpecs.set(
        service.key,
        await prepareDatabaseSpec(deps, project, {
          ...fields,
          image: form.images.get(service.key) ?? service.image,
        }),
      );
    }
  }

  const installId = nanoid(12);
  const now = new Date(deps.now());
  const baseDomain = defaultBaseDomain(deps, deps.db);
  const createdTargets: ServiceTarget[] = [];
  const specsForProxy = new Map<string, AppServiceSpec>();

  const makeInput = (identities: Map<string, ServiceIdentity>): RenderInput => ({
    document,
    project,
    serverHost: baseDomain,
    params: form.params,
    services: identities,
  });

  const portFields: Record<string, string> = {};
  deps.db.transaction((tx) => {
    const identities = new Map<string, ServiceIdentity>();

    // First the rows and domains, so every name a value can refer to exists.
    for (const { service, name } of planned) {
      const existing = form.existing.get(service.key);
      const identity = identityBase(service, name, existing);
      identities.set(service.key, identity);
      if (existing !== undefined) {
        continue;
      }
      const target = { projectName: project, serviceName: name };
      const placeholder =
        service.kind === "database"
          ? (databaseSpecs.get(service.key) as AppServiceSpec)
          : appServiceSpec.parse({
              ...(service.kind === "compose" ? { compose: {} } : {}),
              template: { installId, role: service.key, kind: service.kind },
            });
      insertService(
        tx,
        project,
        name,
        service.kind === "database" ? service.engine : service.kind,
        service.kind === "database"
          ? { ...placeholder, template: { installId, role: service.key, kind: "database" } }
          : placeholder,
        now,
      );
      createdTargets.push(target);
      if (service.kind !== "database" && service.domain !== null) {
        identity.domain = assignDefaultDomain(deps, tx, target, now, {
          port: service.domain.port,
          path: service.domain.path,
          https: service.domain.https,
          composeService: service.kind === "compose" ? service.domain.child : null,
        });
      } else if (service.kind === "compose") {
        identity.domain = assignDefaultDomain(deps, tx, target, now, { composeService: "" });
      }
    }

    // Then what those rows only now can say about each other.
    const input = makeInput(identities);
    for (const { service, name } of planned) {
      if (service.kind === "database" || form.existing.has(service.key)) {
        continue;
      }
      const spec = buildSpec(deps, service, input, form, installId, portFields);
      if (service.kind === "compose" && spec.compose !== null) {
        const content = spec.compose.source?.type === "inline" ? spec.compose.source.content : "";
        // The person confirmed this exact file by confirming the form it came from.
        spec.compose = {
          ...spec.compose,
          acknowledgedHash: fieldsInput.acknowledgeHostAccess ? hashCompose(content) : null,
        };
      }
      saveServiceSpec(tx, project, name, spec, now);
      specsForProxy.set(name, spec);
    }

    if (Object.keys(portFields).length > 0) {
      throw badRequest("validation_failed", "Some fields need attention.", portFields);
    }

    tx.insert(templateInstalls)
      .values(toInstallRow(installId, project, document, fieldsInput.source.type === "schema", input, now))
      .run();
  });

  // The rows exist, so what follows can only leave out parts of the configuration on disk.
  await materialize(deps, project, createdTargets, specsForProxy);

  deps.actions.record({
    type: templateActionTypes.install,
    title: `Install ${document.name} in ${project}`,
    projectName: project,
    actorEmail,
  });
  return getInstall(deps, project, installId);
}

/** What a created service needs on disk. Failing here removes only what this install created. */
async function materialize(
  deps: AppDeps,
  project: string,
  created: readonly ServiceTarget[],
  specs: ReadonlyMap<string, AppServiceSpec>,
): Promise<void> {
  try {
    for (const target of created) {
      await mkdir(join(serviceDir(deps, project, target.serviceName), "code"), {
        recursive: true,
        mode: 0o755,
      });
      const spec = specs.get(target.serviceName);
      if (spec !== undefined) {
        if (spec.compose?.source?.type === "inline") {
          await writeInlineCompose(deps, target, spec.compose.source.content);
        }
        await writeProxyConfig(deps, target, spec);
      }
    }
  } catch (error) {
    for (const target of created) {
      await removeServiceEverywhere(deps, target, () => {}).catch((cleanupError: unknown) => {
        deps.logger.warn({ err: cleanupError, target }, "Could not clean up after a failed install");
      });
    }
    throw error;
  }
}

const POLL_MS = 500;

/** How one component ended. The orchestrating Action reports the first one that didn't work. */
async function waitForAction(deps: Pick<AppDeps, "db">, id: string, signal: AbortSignal): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const row = deps.db.select().from(actions).where(eq(actions.id, id)).get();
    if (row === undefined) {
      throw new Error("The action disappeared.");
    }
    if (row.status === "succeeded") {
      return;
    }
    if (row.status === "failed" || row.status === "cancelled" || row.status === "uncertain") {
      throw new Error(row.error ?? `It ended as ${row.status}.`);
    }
    await sleep(POLL_MS, undefined, { signal });
  }
}

/**
 * Deploys the components in dependency order, each through the ordinary deploy of its own service,
 * so each one has its own log and its own row in Deployments. A `pending` run skips what is already
 * running, which is what makes it the way to resume after a failure.
 */
export function enqueueInstallDeploy(
  deps: AppDeps,
  project: string,
  id: string,
  request: { scope?: "pending" | "all" },
  actorEmail: string | undefined,
): ActionRow {
  const row = requireInstall(deps, project, id);
  const scope = deployRequestScope(request);
  return deps.actions.enqueue({
    type: templateActionTypes.deploy,
    title: `Deploy ${row.templateName} in ${project}`,
    projectName: project,
    actorEmail,
    run: async (ctx) => {
      const live = await readLiveState(deps);
      const active = indexActiveActions(deps);
      const roles = serviceRows(deps, project, id);
      const planned = orderRecords(roles);
      for (const record of planned) {
        const target = { projectName: project, serviceName: record.name };
        const summary = summarize(deps, record, live, active);
        if (scope === "pending" && summary.status === "running") {
          ctx.log(`${record.name} is already running`);
          continue;
        }
        ctx.log(`Deploying ${record.name}`);
        const action = enqueueDeploy(deps, target, actorEmail);
        await waitForAction(deps, action.id, ctx.signal).catch((error: unknown) => {
          throw new Error(`${record.name}: ${error instanceof Error ? error.message : String(error)}`);
        });
        ctx.log(`${record.name} is up`);
      }
    },
  });
}

const deployRequestScope = (request: { scope?: "pending" | "all" }) => request.scope ?? "pending";

/** Dependencies first: a database comes before anything that connects to it. */
function orderRecords(records: readonly ServiceRecord[]): ServiceRecord[] {
  const rank = (record: ServiceRecord) => (record.spec.template?.kind === "database" ? 0 : 1);
  return [...records].sort((a, b) => rank(a) - rank(b));
}

/** Removes every service the install created, and nothing else, in this project only. */
export function enqueueInstallRemoval(
  deps: AppDeps,
  project: string,
  id: string,
  confirm: string,
  actorEmail: string | undefined,
): ActionRow {
  const row = requireInstall(deps, project, id);
  if (confirm !== row.templateName) {
    throw conflict("confirmation_mismatch", "Type the template's exact name to confirm.", {
      confirm: "Does not match the template's name",
    });
  }
  return deps.actions.enqueue({
    type: templateActionTypes.remove,
    title: `Remove ${row.templateName} from ${project}`,
    projectName: project,
    actorEmail,
    run: async (ctx) => {
      for (const record of orderRecords(serviceRows(deps, project, id)).reverse()) {
        ctx.log(`Removing ${record.name}`);
        const action = enqueueDestroy(
          deps,
          { projectName: project, serviceName: record.name },
          record.name,
          actorEmail,
        );
        await waitForAction(deps, action.id, ctx.signal);
      }
      deps.db.delete(templateInstalls).where(eq(templateInstalls.id, id)).run();
      ctx.log("Removed");
    },
  });
}

/** One secret, on request, for the person who asked. Every reveal lands in the activity log. */
export function revealInstallSecret(
  deps: AppDeps,
  project: string,
  id: string,
  service: string,
  name: string,
  actorEmail: string | undefined,
): { value: string } {
  requireInstall(deps, project, id);
  const record = findService(deps.db, project, service);
  const secret = record?.spec.template?.installId === id ? record.spec.references.secrets[name] : undefined;
  if (secret === undefined) {
    throw notFound("This install has no such secret.");
  }
  deps.actions.record({
    type: templateActionTypes.reveal,
    title: `Reveal ${name} of ${project}/${service}`,
    projectName: project,
    serviceName: service,
    actorEmail,
  });
  return { value: deps.secrets.unseal(secret.sealed, TEMPLATE_SECRET_CONTEXT) };
}
