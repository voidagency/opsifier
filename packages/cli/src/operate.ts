import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ClientError, type ServiceRef } from "@opsifier/client";
import type {
  BackupConfigEntry,
  DatabaseSecretName,
  DomainEntry,
  ScriptEntry,
  ScriptRunDetail,
} from "@opsifier/contract";
import { formatTime, renderFields, renderTable, sizeText } from "./format";
import type { MessageKey } from "./messages";
import {
  type Command,
  type CommandContext,
  type CommandResult,
  label,
  noMoreArguments,
  queued,
  requireYes,
  serviceAt,
  started,
  usage,
  waitOption,
} from "./shared";
import { durationText, pollUntil, showNewOutput } from "./wait";

/**
 * The commands that run a service once it is deployed: its domains, maintenance page, database
 * credentials, scripts, backups and readings.
 */

const yesOption = { yes: { type: "boolean", short: "y", description: "flag.yes" } } as const;

/** `verb` when the first positional is one of `verbs`, and where the rest of the arguments start. */
function verbOf<V extends string>(context: CommandContext, verbs: readonly V[]): { verb?: V; from: number } {
  const first = context.positionals[0];
  return verbs.includes(first as V) ? { verb: first as V, from: 1 } : { from: 0 };
}

function oneArgument(context: CommandContext, index: number, name: string): string {
  const value = context.positionals[index];
  if (value === undefined) {
    throw usage(context.t("usage.missingArgument", { name }));
  }
  noMoreArguments(context, index + 1);
  return value;
}

// ---- domains ----

function portFrom(context: CommandContext, value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw usage(context.t("usage.port", { value }));
  }
  return port;
}

/** `example.com`, or a whole address such as `https://example.com/api`, whose path is then used. */
function hostAndPath(context: CommandContext, value: string): { host: string; path?: string } {
  if (!value.includes("://")) {
    if (value.includes("/")) {
      throw usage(context.t("usage.host", { value }));
    }
    return { host: value };
  }
  try {
    const url = new URL(value);
    return { host: url.hostname, ...(url.pathname === "/" ? {} : { path: url.pathname }) };
  } catch {
    throw usage(context.t("usage.host", { value }));
  }
}

/** A host as the panel keeps it: lower case, and in punycode. */
function hostKey(host: string): string {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host.toLowerCase();
  }
}

/** `/api/` and `/api` are the same route. */
const pathKey = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") || "/" : path);

/** The route of a domain, by its host, and by its path when the host has several. */
function domainNamed(context: CommandContext, domains: readonly DomainEntry[], value: string): DomainEntry {
  const { host, path: fromAddress } = hostAndPath(context, value);
  const path = (context.flags.path as string | undefined) ?? fromAddress;
  const matching = domains.filter(
    (domain) =>
      hostKey(domain.host) === hostKey(host) &&
      (path === undefined || pathKey(domain.path) === pathKey(path)),
  );
  if (matching.length === 0) {
    throw new ClientError("not_found", context.t("domains.unknown", { host: value }), 404);
  }
  if (matching.length > 1) {
    throw usage(
      context.t("usage.domainPath", { host, paths: matching.map((domain) => domain.path).join(", ") }),
    );
  }
  return matching[0] as DomainEntry;
}

function domainsTable(context: CommandContext, domains: readonly DomainEntry[]): string {
  if (domains.length === 0) {
    return context.t("empty.domains");
  }
  return renderTable(
    [context.t("col.address"), context.t("col.port"), context.t("col.primary")],
    domains.map((domain) => [
      domain.url,
      String(domain.port),
      domain.primary ? context.t("domains.primaryMark") : "",
    ]),
  );
}

async function domains(context: CommandContext): Promise<CommandResult> {
  const { t, flags } = context;
  const { verb, from } = verbOf(context, ["add", "remove", "primary"] as const);
  const { target, next } = await serviceAt(context, from);

  if (verb === undefined) {
    noMoreArguments(context, next);
    const list = await context.api.domains(target);
    return { data: list, text: () => domainsTable(context, list.domains) };
  }

  const value = oneArgument(context, next, "<host>");
  if (verb === "add") {
    const { host, path: fromAddress } = hostAndPath(context, value);
    const port = portFrom(context, flags.port as string | undefined);
    const path = (flags.path as string | undefined) ?? fromAddress;
    const added = await context.api.addDomain(target, {
      host,
      ...(path === undefined ? {} : { path }),
      ...(port === undefined ? {} : { port }),
      https: flags.http !== true,
    });
    const domain = flags.primary === true ? await context.api.primaryDomain(target, added.id) : added;
    return {
      data: domain,
      text: () =>
        [
          t(domain.primary ? "domains.addedPrimary" : "domains.added", {
            url: domain.url,
            target: label(target),
          }),
          context.styles.dim(t("domains.dns", { host: domain.host })),
        ].join("\n"),
    };
  }

  const domain = domainNamed(context, (await context.api.domains(target)).domains, value);
  if (verb === "remove") {
    requireYes(context, t("confirm.removeDomain", { url: domain.url, target: label(target) }));
    const removed = await context.api.removeDomain(target, domain.id);
    return { data: removed, text: () => t("domains.removed", { url: domain.url }) };
  }
  const primary = await context.api.primaryDomain(target, domain.id);
  return { data: primary, text: () => t("domains.madePrimary", { url: primary.url, target: label(target) }) };
}

// ---- maintenance ----

async function maintenance(context: CommandContext): Promise<CommandResult> {
  const { t, flags } = context;
  const { verb, from } = verbOf(context, ["on", "off"] as const);
  const { target, next } = await serviceAt(context, from);
  noMoreArguments(context, next);
  const current = await context.api.maintenance(target);
  if (verb === undefined) {
    return {
      data: current,
      text: () =>
        current.enabled === true
          ? t("maintenance.isOn", { target: label(target), title: current.title || "-" })
          : t("maintenance.isOff", { target: label(target) }),
    };
  }
  if (verb === "on") {
    requireYes(context, t("confirm.maintenance", { target: label(target) }));
  }
  // The panel saves the whole page at once: what is not changed here is sent back as it was.
  const saved = await context.api.saveMaintenance(target, {
    ...current,
    enabled: verb === "on",
    ...(flags.title === undefined ? {} : { title: flags.title as string }),
    ...(flags.subtitle === undefined ? {} : { subtitle: flags.subtitle as string }),
  });
  return {
    data: saved,
    text: () =>
      t(verb === "on" ? "maintenance.turnedOn" : "maintenance.turnedOff", { target: label(target) }),
  };
}

// ---- database credentials ----

async function database(context: CommandContext): Promise<CommandResult> {
  const { t, flags } = context;
  const { verb, from } = verbOf(context, ["url", "password"] as const);
  const { target, next } = await serviceAt(context, from);
  noMoreArguments(context, next);

  if (verb === undefined) {
    const credentials = await context.api.credentials(target);
    return {
      data: credentials,
      text: () =>
        renderFields([
          [t("field.engine"), credentials.engine],
          [t("field.dbUser"), credentials.user],
          [t("field.dbName"), credentials.databaseName ?? "-"],
          [t("field.inside"), `${credentials.internal.host}:${credentials.internal.port}`],
          [
            t("field.outside"),
            credentials.external === null
              ? t("db.notExposed")
              : `${credentials.external.host}:${credentials.external.port}`,
          ],
          [t("field.url"), credentials.internal.maskedUrl],
          ...(credentials.rotationUnresolved
            ? [[t("field.warning"), t("db.rotationUnresolved")] as [string, string]]
            : []),
        ]),
    };
  }

  const secret: DatabaseSecretName =
    verb === "url"
      ? flags.external === true
        ? "externalUrl"
        : "internalUrl"
      : flags.root === true
        ? "rootPassword"
        : "password";
  requireYes(context, t("confirm.revealSecret", { target: label(target) }));
  const { value } = await context.api.revealCredential(target, secret);
  return { data: { [secret]: value }, text: () => value };
}

// ---- scripts ----

function scheduleText(script: ScriptEntry): string {
  return script.schedule == null ? "-" : `${script.schedule.cron} (${script.schedule.timeZone})`;
}

function scriptsTable(context: CommandContext, scripts: readonly ScriptEntry[]): string {
  if (scripts.length === 0) {
    return context.t("empty.scripts");
  }
  return renderTable(
    [
      context.t("col.name"),
      context.t("col.schedule"),
      context.t("col.afterDeploy"),
      context.t("col.lastRun"),
    ],
    scripts.map((script) => [
      script.name,
      scheduleText(script),
      script.runAfterDeploy === true ? context.t("scripts.yes") : "",
      script.lastRun === null
        ? "-"
        : `${script.lastRun.status} ${formatTime(script.lastRun.finishedAt ?? script.lastRun.createdAt)}`,
    ]),
  );
}

async function scriptText(context: CommandContext): Promise<string> {
  const { t, flags } = context;
  const command = flags.command as string | undefined;
  const file = flags.file as string | undefined;
  if ((command === undefined) === (file === undefined)) {
    throw usage(t("usage.scriptBody"));
  }
  if (command !== undefined) {
    return command;
  }
  try {
    return await readFile(resolve(context.cwd, file as string), "utf8");
  } catch (error) {
    throw usage(t("usage.dataFile", { file: file as string, reason: (error as Error).message }));
  }
}

async function scripts(context: CommandContext): Promise<CommandResult> {
  const { t, flags } = context;
  const { verb, from } = verbOf(context, ["add", "remove"] as const);
  const { target, next } = await serviceAt(context, from);

  if (verb === undefined) {
    noMoreArguments(context, next);
    const list = await context.api.scripts(target);
    return { data: list, text: () => scriptsTable(context, list.scripts) };
  }

  const name = oneArgument(context, next, "<name>");
  if (verb === "add") {
    const cron = flags.cron as string | undefined;
    if (flags.tz !== undefined && cron === undefined) {
      throw usage(t("usage.tzWithoutCron"));
    }
    const script = await scriptText(context);
    const list = await context.api.addScript(target, {
      name,
      script,
      ...(flags["after-deploy"] === true ? { runAfterDeploy: true } : {}),
      ...(cron === undefined
        ? {}
        : { schedule: { cron, timeZone: (flags.tz as string | undefined) ?? "UTC" } }),
    });
    return {
      data: list,
      text: () =>
        [
          t("scripts.added", { name, target: label(target) }),
          context.styles.dim(t("scripts.runHint", { name })),
        ].join("\n"),
    };
  }

  requireYes(context, t("confirm.removeScript", { name, target: label(target) }));
  // Scripts are removed by position: read right before, and checked right after.
  const list = await context.api.scripts(target);
  const index = list.scripts.findIndex((script) => script.name === name);
  if (index === -1) {
    throw new ClientError("not_found", t("scripts.unknown", { name, target: label(target) }), 404);
  }
  const after = await context.api.removeScript(target, index);
  if (after.scripts.some((script) => script.name === name)) {
    throw new ClientError("conflict", t("scripts.changed", { name }), 409);
  }
  return { data: after, text: () => t("scripts.removed", { name, target: label(target) }) };
}

const RUNNING = new Set<ScriptRunDetail["status"]>(["queued", "running"]);

/** Runs a saved script in the service's container and, unless told not to, stays until it ends. */
async function runScript(context: CommandContext): Promise<CommandResult> {
  const { t } = context;
  const { target, next } = await serviceAt(context, 0);
  const name = oneArgument(context, next, "<script>");
  const started = await context.api.runScript(target, name);
  if (context.flags.detach === true) {
    return queued(context, started, "run.queued", label(target), { name });
  }

  let shown = "";
  const run = await pollUntil(
    context,
    started.id,
    (signal) => context.api.scriptRun(target, started.run.id, signal),
    (value) => !RUNNING.has(value.status),
    (value) => {
      if (context.mode === "text") {
        shown = showNewOutput(context, shown, value.output);
      }
    },
  );
  if (shown !== "" && !shown.endsWith("\n")) {
    context.write("\n");
  }
  const finished = run;
  const duration = durationText(finished.startedAt, finished.finishedAt);
  if (finished.status === "succeeded") {
    return { data: finished, text: () => context.styles.dim(t("run.succeeded", { name, duration })) };
  }
  if (context.mode === "json") {
    context.print(JSON.stringify(finished, null, 2));
  }
  throw new ClientError(
    "action_failed",
    t("run.failed", {
      name,
      status: finished.status,
      code: finished.exitCode ?? "-",
      reason: finished.note?.message ?? "-",
    }),
  );
}

// ---- backups ----

function backupsText(
  context: CommandContext,
  document: Awaited<ReturnType<CommandContext["api"]["backups"]>>,
): string {
  const { t } = context;
  const backups = document.backups.filter((backup) => backup.deletedAt === null);
  const table =
    backups.length === 0
      ? t("empty.backups")
      : renderTable(
          [t("col.status"), t("col.what"), t("col.size"), t("col.where"), t("col.created"), t("col.id")],
          backups.map((backup) => [
            backup.status,
            backup.databaseName ?? backup.volumeName ?? backup.scope,
            backup.sizeBytes === null ? "-" : sizeText(backup.sizeBytes),
            backup.storageProviderName,
            formatTime(backup.createdAt),
            backup.id,
          ]),
        );
  const configs = document.configs.map((config) =>
    t("backups.config", {
      id: config.id,
      what: config.databaseName ?? config.volumeName ?? config.scope,
      schedule: config.schedule,
      where: config.storageProviderName ?? "-",
      next: formatTime(config.nextRunAt),
    }),
  );
  return [
    table,
    ...(configs.length === 0 ? [] : ["", ...configs.map((line) => context.styles.dim(line))]),
  ].join("\n");
}

function backupConfigNamed(
  context: CommandContext,
  target: ServiceRef,
  configs: readonly BackupConfigEntry[],
  id: string | undefined,
): BackupConfigEntry {
  if (id !== undefined) {
    const config = configs.find((candidate) => candidate.id === id);
    if (config === undefined) {
      throw new ClientError("not_found", context.t("backups.unknown", { id, target: label(target) }), 404);
    }
    return config;
  }
  if (configs.length === 1) {
    return configs[0] as BackupConfigEntry;
  }
  throw usage(
    configs.length === 0
      ? context.t("backups.none", { target: label(target) })
      : context.t("usage.backupConfig", { ids: configs.map((config) => config.id).join(", ") }),
  );
}

async function backups(context: CommandContext): Promise<CommandResult> {
  const { verb, from } = verbOf(context, ["run"] as const);
  const { target, next } = await serviceAt(context, from);
  const document = await context.api.backups(target);
  if (verb === undefined) {
    noMoreArguments(context, next);
    return { data: document, text: () => backupsText(context, document) };
  }
  const id = context.positionals[next];
  noMoreArguments(context, next + 1);
  const config = backupConfigNamed(context, target, document.configs, id);
  const action = await context.api.runBackup(target, config.id);
  return started(context, action, "backups.queued", label(target));
}

// ---- readings ----

async function ps(context: CommandContext): Promise<CommandResult> {
  const { t } = context;
  const { target, next } = await serviceAt(context, 0);
  noMoreArguments(context, next);
  const [service, metrics] = await Promise.all([context.api.service(target), context.api.metrics(target)]);
  const data = { status: service.status, replicas: service.replicas, metrics };
  return {
    data,
    text: () => {
      const heading = `${label(target)}  ${context.styles.state(service.status, t(`state.${service.status}` as MessageKey))}  ${service.replicas.running}/${service.replicas.desired}`;
      if (metrics.available === false || metrics.readAt === null) {
        return [heading, t("ps.noReadings")].join("\n");
      }
      const memory =
        metrics.memoryUsedBytes === null
          ? "-"
          : metrics.memoryLimitBytes
            ? t("ps.memoryOf", {
                used: sizeText(metrics.memoryUsedBytes),
                limit: sizeText(metrics.memoryLimitBytes),
              })
            : sizeText(metrics.memoryUsedBytes);
      return [
        heading,
        renderFields([
          [t("field.cpu"), metrics.cpuPercent === null ? "-" : `${metrics.cpuPercent.toFixed(1)} %`],
          [t("field.memory"), memory],
          [
            t("field.network"),
            t("ps.network", {
              rx: metrics.networkRxBytes === null ? "-" : sizeText(metrics.networkRxBytes),
              tx: metrics.networkTxBytes === null ? "-" : sizeText(metrics.networkTxBytes),
            }),
          ],
          [t("field.readAt"), formatTime(metrics.readAt)],
        ]),
      ].join("\n");
    },
  };
}

export const OPERATE_COMMANDS: readonly Command[] = [
  {
    name: "ps",
    group: "everyday",
    args: "[<project>/<service>]",
    run: ps,
  },
  {
    name: "domains",
    group: "everyday",
    verbs: ["add", "remove", "primary"],
    args: "[<project>/<service>]",
    more: [
      "domains add [<project>/<service>] <host> [--port 3000] [--path /api] [--primary]",
      "domains primary [<project>/<service>] <host>",
      "domains remove [<project>/<service>] <host> --yes",
    ],
    options: {
      port: { type: "string", description: "flag.port" },
      path: { type: "string", description: "flag.domainPath" },
      primary: { type: "boolean", description: "flag.primary" },
      http: { type: "boolean", description: "flag.http" },
      ...yesOption,
    },
    run: domains,
  },
  {
    name: "maintenance",
    group: "everyday",
    verbs: ["on", "off"],
    args: "[on | off] [<project>/<service>]",
    options: {
      title: { type: "string", description: "flag.title" },
      subtitle: { type: "string", description: "flag.subtitle" },
      ...yesOption,
    },
    run: maintenance,
  },
  {
    name: "db",
    group: "everyday",
    verbs: ["url", "password"],
    args: "[<project>/<service>]",
    more: [
      "db url [<project>/<service>] [--external] --yes",
      "db password [<project>/<service>] [--root] --yes",
    ],
    options: {
      external: { type: "boolean", description: "flag.external" },
      root: { type: "boolean", description: "flag.root" },
      ...yesOption,
    },
    run: database,
  },
  {
    name: "scripts",
    group: "everyday",
    verbs: ["add", "remove"],
    args: "[<project>/<service>]",
    more: [
      "scripts add [<project>/<service>] <name> (--command <script> | --file <path>) [--cron <expression> [--tz <zone>]] [--after-deploy]",
      "scripts remove [<project>/<service>] <name> --yes",
    ],
    options: {
      command: { type: "string", description: "flag.command" },
      file: { type: "string", description: "flag.file" },
      cron: { type: "string", description: "flag.cron" },
      tz: { type: "string", description: "flag.tz" },
      "after-deploy": { type: "boolean", description: "flag.afterDeploy" },
      ...yesOption,
    },
    run: scripts,
  },
  {
    name: "run",
    group: "everyday",
    args: "[<project>/<service>] <script>",
    options: { detach: { type: "boolean", short: "d", description: "flag.detach" } },
    run: runScript,
  },
  {
    name: "backups",
    group: "everyday",
    verbs: ["run"],
    args: "[<project>/<service>]",
    more: ["backups run [<project>/<service>] [<setting id>] [--wait]"],
    options: waitOption,
    run: backups,
  },
];
