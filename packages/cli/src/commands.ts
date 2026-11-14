import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, parse, resolve, sep } from "node:path";
import type { ServiceRef } from "@opsifier/client";
import {
  buildCatalogue,
  ClientError,
  classifyOperation,
  connectionFromEnv,
  describeOperation,
  fetchOpenApiDocument,
  isExposedOnTheWire,
  normalizeApiPath,
} from "@opsifier/client";
import type {
  ActionEntry,
  CallerIdentity,
  CreateDatabaseRequest,
  EnvSummary,
  LogSearchQuery,
  ProjectSummary,
  ReleaseEntry,
  ReleaseList,
  SaveSourceRequest,
  ServiceDetail,
  ServiceLogLine,
  ServiceStatus,
  ServiceSummary,
} from "@opsifier/contract";
import { endKeptSession, loginWithBrowser, usersCommand } from "./accounts";
import { completionScript, SHELLS, type Shell } from "./completion";
import { readCredentials, writeCredentials } from "./credentials";
import { ENV_NAME, readEnv, setEnv, unsetEnv } from "./env";
import { bySeverity, formatTime, renderFields, renderTable, sizeText, WAKE_MARK } from "./format";
import { findLink, removeLink, writeLink } from "./link";
import type { MessageKey } from "./messages";
import { OPERATE_COMMANDS } from "./operate";
import { packFolder } from "./pack";
import {
  argument,
  type Command,
  type CommandContext,
  type CommandResult,
  confirmValue,
  label,
  namesService,
  noMoreArguments,
  type OptionSpec,
  originOf,
  parseTarget,
  queued,
  requireYes,
  serviceAt,
  sourceText,
  started,
  targetOf,
  usage,
  waitOption,
} from "./shared";
import { sleep } from "./wait";

export type { Command, CommandContext, CommandResult, OptionSpec } from "./shared";

const stateWord = (context: CommandContext, state: ServiceStatus) =>
  context.t(`state.${state}` as MessageKey);

function serviceRows(context: CommandContext, services: readonly ServiceSummary[]): string[][] {
  return [...services]
    .sort((a, b) => bySeverity(a.status, b.status) || a.name.localeCompare(b.name))
    .map((service) => [
      service.projectName,
      service.name,
      service.type,
      stateWord(context, service.status),
      `${service.replicas.running}/${service.replicas.desired}`,
      formatTime(service.lastDeployedAt),
      service.activeAction?.type ?? "",
    ]);
}

function servicesTable(
  context: CommandContext,
  services: readonly ServiceSummary[],
  rows: string[][] = serviceRows(context, services),
): string {
  const statusFor = new Map(
    services.map((service) => [`${service.projectName}/${service.name}`, service.status]),
  );
  return renderTable(
    [
      context.t("col.project"),
      context.t("col.service"),
      context.t("col.type"),
      context.t("col.state"),
      context.t("col.replicas"),
      context.t("col.lastDeploy"),
      context.t("col.work"),
    ],
    rows,
    (padded, row, column) => {
      const status = statusFor.get(`${row[0]}/${row[1]}`);
      return column === 3 && status !== undefined ? context.styles.state(status, padded) : padded;
    },
  );
}

function projectsText(context: CommandContext, projects: readonly ProjectSummary[]): string {
  if (projects.length === 0) {
    return context.t("empty.projects");
  }
  const services = projects.flatMap((project) => project.services);
  const empty = projects.filter((project) => project.services.length === 0);
  const rows = [
    ...serviceRows(context, services),
    ...empty.map((project) => [project.name, "-", "", "", "", "", ""]),
  ];
  return servicesTable(context, services, rows);
}

/** `45s`, `15m`, `2h`, `1d`, or a plain number of seconds, as the API takes it. */
function secondsFrom(context: CommandContext, value: string): number {
  const match = /^(\d+)([smhd]?)$/.exec(value.trim());
  if (match === null) {
    throw usage(context.t("usage.duration", { value }));
  }
  const unit = { "": 1, s: 1, m: 60, h: 3600, d: 86_400 }[match[2] as "" | "s" | "m" | "h" | "d"];
  return Number(match[1]) * unit;
}

function positiveInteger(context: CommandContext, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw usage(context.t("usage.limit", { value }));
  }
  return parsed;
}

function logLine(context: CommandContext, line: ServiceLogLine): string {
  const stamp = line.at === null ? "" : `${line.at} `;
  const stream = line.stream === "stderr" ? "stderr " : "";
  return `${context.styles.dim(`${stamp}${stream}`)}${line.line}`;
}

/** Long enough that one poll costs a Docker read, short enough to feel live. */
const FOLLOW_POLL_MS = 2_000;
/** Each poll looks a little further back than the last, and what it has already shown is dropped. */
const FOLLOW_OVERLAP_SECONDS = 3;
const MAX_LOG_LIMIT = 2_000;

/**
 * The API offers searches, not a stream, to anything but a browser session: this keeps asking for the
 * last few seconds and prints what it has not printed yet. It remembers nothing past one poll.
 */
async function followLogs(
  context: CommandContext,
  target: ServiceRef,
  query: Partial<LogSearchQuery>,
): Promise<void> {
  const emit = (line: ServiceLogLine) =>
    context.print(context.mode === "json" ? JSON.stringify(line) : logLine(context, line));
  const keyOf = (line: ServiceLogLine) => `${line.at}\u0000${line.stream}\u0000${line.line}`;

  const first = await context.api.logs(target, query, context.signal);
  first.lines.forEach(emit);
  let seen = new Set(first.lines.map(keyOf));
  let lastAnswer = Date.now();
  let failing = false;

  while (!context.signal.aborted) {
    await sleep(FOLLOW_POLL_MS, context.signal);
    if (context.signal.aborted) {
      return;
    }
    const startedAt = Date.now();
    const since = Math.ceil((startedAt - lastAnswer) / 1000) + FOLLOW_OVERLAP_SECONDS;
    try {
      const { lines } = await context.api.logs(
        target,
        { ...query, since, limit: MAX_LOG_LIMIT },
        context.signal,
      );
      for (const line of lines.filter((candidate) => !seen.has(keyOf(candidate)))) {
        emit(line);
      }
      seen = new Set(lines.map(keyOf));
      lastAnswer = startedAt;
      failing = false;
    } catch (error) {
      if (context.signal.aborted) {
        return;
      }
      // A key that was revoked or a service that went away will not come back by retrying.
      if (error instanceof ClientError && error.status !== undefined && error.status < 500) {
        throw error;
      }
      if (!failing) {
        context.warn(context.t("warn.pollFailed", { reason: (error as Error).message }));
      }
      failing = true;
    }
  }
}

const logOptions: Record<string, OptionSpec> = {
  follow: { type: "boolean", short: "f", description: "flag.follow" },
  since: { type: "string", description: "flag.since" },
  grep: { type: "string", description: "flag.grep" },
  stream: { type: "string", description: "flag.stream" },
  level: { type: "string", description: "flag.level" },
  limit: { type: "string", short: "n", description: "flag.limit" },
};

const API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

async function bodyFrom(context: CommandContext, value: string): Promise<unknown> {
  let text = value;
  if (value.startsWith("@")) {
    const file = value.slice(1);
    try {
      text = file === "-" ? await context.readStdin() : await readFile(file, "utf8");
    } catch (error) {
      throw usage(context.t("usage.dataFile", { file, reason: (error as Error).message }));
    }
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw usage(context.t("usage.json", { reason: (error as Error).message }));
  }
}

function queryFrom(context: CommandContext): Record<string, string> {
  const pairs = (context.flags.query as string[] | undefined) ?? [];
  const query: Record<string, string> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      throw usage(context.t("usage.query", { value: pair }));
    }
    query[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return query;
}

/** The long tail: anything the API offers, with exactly the rights of the key. */
async function callApi(context: CommandContext): Promise<CommandResult> {
  const method = argument(context, 0, "<METHOD>").toUpperCase();
  if (!API_METHODS.has(method)) {
    throw usage(context.t("usage.extraArgument", { value: method }));
  }
  const path = normalizeApiPath(argument(context, 1, "<path>"));
  noMoreArguments(context, 2);
  const data = context.flags.data as string | undefined;
  const body = data === undefined ? undefined : await bodyFrom(context, data);
  if (classifyOperation(method, path).kind === "destructive") {
    requireYes(context, context.t("confirm.api"));
  }
  const document = await context.client.request(method, path, { query: queryFrom(context), body });
  return { data: document, text: () => JSON.stringify(document, null, 2) };
}

async function listOperations(context: CommandContext): Promise<CommandResult> {
  const needle = context.positionals[1]?.toLowerCase();
  const [document, identity] = await Promise.all([
    fetchOpenApiDocument(context.client),
    context.api.identity(),
  ]);
  const entries = buildCatalogue(document, identity).filter(
    (entry) =>
      needle === undefined ||
      `${entry.method} ${entry.path} ${entry.summary} ${entry.group}`.toLowerCase().includes(needle),
  );
  return {
    data: entries,
    text: () =>
      entries.length === 0
        ? context.t("empty.operations")
        : renderTable(
            [context.t("col.method"), context.t("col.path"), context.t("col.kind"), context.t("col.summary")],
            entries.map((entry) => [entry.method, entry.path, entry.kind, entry.summary]),
          ),
  };
}

async function describeOne(context: CommandContext): Promise<CommandResult> {
  const method = argument(context, 1, "<METHOD>");
  const path = normalizeApiPath(argument(context, 2, "<path>"));
  noMoreArguments(context, 3);
  const description = describeOperation(await fetchOpenApiDocument(context.client), method, path);
  return { data: description, text: () => JSON.stringify(description, null, 2) };
}

/** The options every command takes, which the command line itself reads: see cli.ts. */
export const GLOBAL_FLAGS = ["json", "text", "help"] as const;

export const COMMANDS: readonly Command[] = [
  {
    name: "link",
    group: "setup",
    args: "<project>/<service>",
    async run(context) {
      const target = targetOf(context);
      noMoreArguments(context, 1);
      // A mistyped name should fail now, not at the first deploy from this folder.
      await context.api.service(target);
      const link = { service: label(target), panel: context.client.panelOrigin };
      const file = await writeLink(context.cwd, link);
      return {
        data: { ...link, file },
        text: () => context.t("link.done", { service: link.service, panel: link.panel, file }),
      };
    },
  },
  {
    name: "unlink",
    group: "setup",
    args: "",
    offline: true,
    async run(context) {
      noMoreArguments(context, 0);
      const result = await removeLink(context.cwd);
      return {
        data: result,
        text: () => context.t(result.removed ? "unlink.done" : "unlink.none", { file: result.file }),
      };
    },
  },
  {
    name: "login",
    group: "setup",
    args: "[<panel address>]",
    more: ["login --web [<panel address>]"],
    options: { web: { type: "boolean", description: "flag.web" } },
    offline: true,
    run: login,
  },
  {
    name: "logout",
    group: "setup",
    args: "[<panel address>]",
    offline: true,
    run: logout,
  },
  {
    name: "users",
    group: "other",
    args: "[invite <email>… | set <email> | deactivate <email> | activate <email>]",
    verbs: ["invite", "set", "deactivate", "activate"],
    more: [
      "users invite ada@example.com [--admin] [--all-projects viewer|operator] [--channel <id>]",
      "users set ada@example.com [--role admin|member] [--all-projects viewer|operator|none]",
      "users deactivate ada@example.com",
    ],
    options: {
      admin: { type: "boolean", description: "flag.admin" },
      role: { type: "string", description: "flag.role" },
      "all-projects": { type: "string", description: "flag.allProjects" },
      channel: { type: "string", description: "flag.channel" },
    },
    run: usersCommand,
  },
  {
    name: "create",
    group: "setup",
    args: "<project>[/<service>]",
    more: [
      "create <project>/<service> --image nginx:1.27",
      "create <project>/<service> --git https://github.com/me/app.git [--ref main] [--path /]",
      "create <project>/<service> --dockerfile ./Dockerfile",
      "create <project>/<service> --database postgres",
    ],
    options: {
      image: { type: "string", description: "flag.image" },
      git: { type: "string", description: "flag.git" },
      ref: { type: "string", description: "flag.ref" },
      path: { type: "string", description: "flag.gitPath" },
      dockerfile: { type: "string", description: "flag.dockerfile" },
      database: { type: "string", description: "flag.database" },
      link: { type: "boolean", description: "flag.link" },
      deploy: { type: "boolean", description: "flag.deployCreated" },
      ...waitOption,
    },
    run: create,
  },
  {
    name: "completion",
    group: "setup",
    args: "<bash | zsh | fish>",
    offline: true,
    async run(context) {
      const shell = argument(context, 0, "<bash | zsh | fish>");
      noMoreArguments(context, 1);
      if (!(SHELLS as readonly string[]).includes(shell)) {
        throw usage(context.t("usage.shell", { value: shell }));
      }
      context.write(completionScript(shell as Shell, COMMANDS, GLOBAL_FLAGS, context.t));
      return undefined;
    },
  },
  {
    name: "__targets",
    group: "hidden",
    args: "",
    async run(context) {
      noMoreArguments(context, 0);
      const { projects } = await context.api.projects();
      for (const service of projects.flatMap((project) => project.services)) {
        context.print(`${service.projectName}/${service.name}`);
      }
      return undefined;
    },
  },
  {
    name: "whoami",
    group: "everyday",
    args: "",
    async run(context) {
      noMoreArguments(context, 0);
      const identity = await context.api.identity();
      return {
        data: identity,
        text: () => {
          const { credential, user, projects } = identity;
          const reach =
            projects === null
              ? context.t("whoami.everyProject")
              : projects.map((project) => `${project.name} (${project.role})`).join(", ") ||
                context.t("whoami.noProject");
          const key =
            credential.kind === "session"
              ? context.t("whoami.session")
              : context.t(credential.expiresAt === null ? "whoami.keyLineNever" : "whoami.keyLine", {
                  name: credential.name,
                  level: credential.level,
                  expires: formatTime(credential.expiresAt),
                });
          return renderFields([
            [context.t("field.panel"), context.client.panelOrigin],
            [context.t("field.key"), key],
            [context.t("field.user"), `${user.email} (${user.role})`],
            [context.t("field.reach"), reach],
          ]);
        },
      };
    },
  },
  {
    name: "projects",
    group: "everyday",
    args: "",
    async run(context) {
      noMoreArguments(context, 0);
      const list = await context.api.projects();
      return { data: list, text: () => projectsText(context, list.projects) };
    },
  },
  {
    name: "services",
    group: "everyday",
    args: "<project>",
    async run(context) {
      const name = argument(context, 0, "<project>");
      noMoreArguments(context, 1);
      const project = await context.api.project(name);
      return {
        data: project,
        text: () =>
          project.services.length === 0
            ? context.t("empty.project")
            : servicesTable(context, project.services),
      };
    },
  },
  {
    name: "status",
    group: "everyday",
    args: "[<project> | <project>/<service>]",
    async run(context) {
      const value = context.positionals[0];
      noMoreArguments(context, 1);
      if (value === undefined) {
        const list = await context.api.projects();
        return { data: list, text: () => projectsText(context, list.projects) };
      }
      if (!value.includes("/")) {
        const project = await context.api.project(value);
        return {
          data: project,
          text: () =>
            project.services.length === 0
              ? context.t("empty.project")
              : servicesTable(context, project.services),
        };
      }
      const target = targetOf(context);
      const service = await context.api.service(target);
      return {
        data: service,
        text: () => {
          const heading = `${label(target)}  ${context.styles.state(service.status, stateWord(context, service.status))}  ${service.replicas.running}/${service.replicas.desired}`;
          const fields: Array<[string, string]> = [
            [context.t("field.type"), service.type],
            [context.t("field.source"), sourceText(service.source)],
            [context.t("field.address"), service.primaryUrl ?? "-"],
            [context.t("field.lastDeploy"), formatTime(service.lastDeployedAt)],
            [
              context.t("field.recent"),
              service.wake.map((outcome) => WAKE_MARK[outcome] ?? "?").join("") || "-",
            ],
          ];
          if (service.activeAction !== null) {
            fields.push([
              context.t("field.inProgress"),
              `${service.activeAction.type} (${service.activeAction.id})`,
            ]);
          }
          return [heading, renderFields(fields)].join("\n");
        },
      };
    },
  },
  {
    name: "logs",
    group: "everyday",
    args: "[<project>/<service>]",
    options: logOptions,
    async run(context) {
      const { target, next } = await serviceAt(context, 0);
      noMoreArguments(context, next);
      const { flags } = context;
      const query: Partial<LogSearchQuery> = {
        q: flags.grep as string | undefined,
        stream: flags.stream as LogSearchQuery["stream"] | undefined,
        level: flags.level as LogSearchQuery["level"] | undefined,
        since: flags.since === undefined ? undefined : secondsFrom(context, flags.since as string),
        limit: flags.limit === undefined ? undefined : positiveInteger(context, flags.limit as string),
      };
      if (flags.follow === true) {
        await followLogs(context, target, query);
        return undefined;
      }
      const result = await context.api.logs(target, query, context.signal);
      return {
        data: result,
        text: () =>
          result.lines.length === 0
            ? context.t("empty.logs")
            : result.lines.map((line) => logLine(context, line)).join("\n"),
      };
    },
  },
  {
    name: "deployments",
    group: "everyday",
    args: "[<project>/<service>]",
    options: { limit: { type: "string", short: "n", description: "flag.limit" } },
    async run(context) {
      const { target, next } = await serviceAt(context, 0);
      noMoreArguments(context, next);
      const limit =
        context.flags.limit === undefined
          ? undefined
          : positiveInteger(context, context.flags.limit as string);
      const page = await context.api.deployments(target, { limit });
      return { data: page, text: () => actionsText(context, page.items, "empty.deployments") };
    },
  },
  {
    name: "deploy",
    group: "everyday",
    args: "[<project>/<service>]",
    options: { force: { type: "boolean", description: "flag.force" }, ...waitOption },
    async run(context) {
      const { target, next } = await serviceAt(context, 0);
      noMoreArguments(context, next);
      const action = await context.api.deploy(target, { force: context.flags.force === true });
      return started(context, action, "deploy.queued", label(target));
    },
  },
  {
    name: "push",
    group: "everyday",
    args: "[<project>/<service>]",
    options: {
      dir: { type: "string", description: "flag.dir" },
      path: { type: "string", description: "flag.uploadPath" },
      "upload-only": { type: "boolean", description: "flag.uploadOnly" },
      "include-secrets": { type: "boolean", description: "flag.includeSecrets" },
      yes: { type: "boolean", short: "y", description: "flag.yes" },
      ...waitOption,
    },
    run: push,
  },
  {
    name: "restart",
    group: "everyday",
    args: "[<project>/<service>]",
    options: waitOption,
    async run(context) {
      const { target, next } = await serviceAt(context, 0);
      noMoreArguments(context, next);
      return started(context, await context.api.restart(target), "restart.queued", label(target));
    },
  },
  {
    name: "start",
    group: "everyday",
    args: "[<project>/<service>]",
    options: waitOption,
    async run(context) {
      const { target, next } = await serviceAt(context, 0);
      noMoreArguments(context, next);
      return started(context, await context.api.start(target), "start.queued", label(target));
    },
  },
  {
    name: "stop",
    group: "everyday",
    args: "[<project>/<service>]",
    options: { yes: { type: "boolean", short: "y", description: "flag.yes" }, ...waitOption },
    async run(context) {
      const { target, next } = await serviceAt(context, 0);
      noMoreArguments(context, next);
      requireYes(context, context.t("confirm.stop", { target: label(target) }));
      return started(context, await context.api.stop(target), "stop.queued", label(target));
    },
  },
  {
    name: "releases",
    group: "everyday",
    args: "[<project>/<service>]",
    async run(context) {
      const { target, next } = await serviceAt(context, 0);
      noMoreArguments(context, next);
      const list = await context.api.releases(target);
      return { data: list, text: () => releasesText(context, list) };
    },
  },
  {
    name: "rollback",
    group: "everyday",
    args: "[<project>/<service>] [<version>]",
    options: { confirm: { type: "string", description: "flag.confirmRollback" }, ...waitOption },
    async run(context) {
      const { target, next } = await serviceAt(context, 0);
      const named = context.positionals[next];
      noMoreArguments(context, next + 1);
      const list = await context.api.releases(target);
      const release =
        named === undefined ? previousRelease(context, target, list) : releaseNamed(context, list, named);
      const confirm = confirmValue(
        context,
        context.t("confirm.rollback", {
          target: label(target),
          version: release.number,
          image: release.image,
          name: target.service,
        }),
      );
      const action = await context.api.rollback(target, release.number, confirm);
      return started(context, action, "rollback.queued", label(target), { version: release.number });
    },
  },
  {
    name: "config",
    group: "everyday",
    verbs: ["get", "set", "unset"],
    args: "[<project>/<service>]",
    more: [
      "config get [<project>/<service>] <NAME>... --yes",
      "config set [<project>/<service>] <NAME>=<value>... [--deploy [--wait]]",
      "config unset [<project>/<service>] <NAME>... --yes [--deploy [--wait]]",
      "config [get | set | unset] --project <project> ...",
    ],
    options: {
      project: { type: "string", description: "flag.envProject" },
      yes: { type: "boolean", short: "y", description: "flag.yes" },
      deploy: { type: "boolean", description: "flag.deploy" },
      ...waitOption,
    },
    run(context) {
      const verb = context.positionals[0];
      if (verb === "get" || verb === "set" || verb === "unset") {
        return changeConfig(context, verb);
      }
      return listConfig(context);
    },
  },
  {
    name: "open",
    group: "everyday",
    args: "[<project>/<service>]",
    async run(context) {
      const { target, next } = await serviceAt(context, 0);
      noMoreArguments(context, next);
      const service = await context.api.service(target);
      const url = service.primaryUrl;
      if (url === null) {
        throw new ClientError("no_address", context.t("open.none", { target: label(target) }), 404);
      }
      return { data: { url }, text: () => context.styles.link(url) };
    },
  },
  ...OPERATE_COMMANDS,
  {
    name: "destroy",
    group: "everyday",
    args: "<project>/<service>",
    options: { confirm: { type: "string", description: "flag.confirm" } },
    async run(context) {
      const target = targetOf(context);
      noMoreArguments(context, 1);
      const confirm = confirmValue(
        context,
        context.t("confirm.destroy", { target: label(target), name: target.service }),
      );
      return queued(
        context,
        await context.api.destroyService(target, confirm),
        "destroy.queued",
        label(target),
      );
    },
  },
  {
    name: "delete-project",
    group: "everyday",
    args: "<project>",
    options: { confirm: { type: "string", description: "flag.confirm" } },
    async run(context) {
      const name = argument(context, 0, "<project>");
      noMoreArguments(context, 1);
      const confirm = confirmValue(context, context.t("confirm.project", { name }));
      return queued(context, await context.api.deleteProject(name, confirm), "deleteProject.queued", name);
    },
  },
  {
    name: "actions",
    group: "everyday",
    args: "",
    options: {
      project: { type: "string", description: "flag.project" },
      service: { type: "string", description: "flag.service" },
      status: { type: "string", description: "flag.status" },
      type: { type: "string", description: "flag.type" },
      limit: { type: "string", short: "n", description: "flag.limit" },
      cursor: { type: "string", description: "flag.cursor" },
    },
    async run(context) {
      noMoreArguments(context, 0);
      const { flags } = context;
      const page = await context.api.actions({
        projectName: flags.project as string | undefined,
        serviceName: flags.service as string | undefined,
        status: flags.status as ActionEntry["status"] | undefined,
        type: flags.type as string | undefined,
        limit: flags.limit === undefined ? undefined : positiveInteger(context, flags.limit as string),
        cursor: flags.cursor as string | undefined,
      });
      return { data: page, text: () => actionsText(context, page.items, "empty.actions") };
    },
  },
  {
    name: "action",
    group: "everyday",
    args: "<id>",
    async run(context) {
      const id = argument(context, 0, "<id>");
      noMoreArguments(context, 1);
      const action = await context.api.action(id);
      return {
        data: action,
        text: () => {
          const fields: Array<[string, string]> = [
            [context.t("col.action"), `${action.title} (${action.type})`],
            [context.t("col.status"), action.status],
            [context.t("col.target"), targetText(action)],
            [context.t("field.by"), `${action.actorEmail ?? "-"} (${action.origin})`],
            [context.t("field.created"), formatTime(action.createdAt)],
            [context.t("field.started"), formatTime(action.startedAt)],
            [context.t("field.finished"), formatTime(action.finishedAt)],
          ];
          if (action.error !== null) {
            fields.push([context.t("field.error"), action.error]);
          }
          const header = renderFields(fields);
          return action.log === "" ? header : [header, "", context.t("field.output"), action.log].join("\n");
        },
      };
    },
  },
  {
    name: "cancel",
    group: "everyday",
    args: "<id>",
    async run(context) {
      const id = argument(context, 0, "<id>");
      noMoreArguments(context, 1);
      const action = await context.api.cancelAction(id);
      return {
        data: action,
        text: () => context.t("action.cancelled", { action: action.id, status: action.status }),
      };
    },
  },
  {
    name: "api",
    group: "other",
    verbs: ["list", "describe", "GET", "POST", "PUT", "PATCH", "DELETE"],
    args: "<METHOD> <path>",
    more: ["api list [text]", "api describe <METHOD> <path>"],
    options: {
      query: { type: "string", short: "q", multiple: true, description: "flag.query" },
      data: { type: "string", short: "d", description: "flag.data" },
      yes: { type: "boolean", short: "y", description: "flag.yes" },
    },
    run(context) {
      if (context.positionals[0] === "list") {
        return listOperations(context);
      }
      if (context.positionals[0] === "describe") {
        return describeOne(context);
      }
      return callApi(context);
    },
  },
];

function releaseNote(context: CommandContext, release: ReleaseEntry): string {
  const notes: string[] = [];
  if (release.active) {
    notes.push(context.t("release.running"));
  }
  if (release.rollbackOf !== null) {
    notes.push(context.t("release.rollbackOf", { version: release.rollbackOf }));
  }
  if (release.refusal !== null && release.refusal !== "active") {
    notes.push(context.t(`refusal.${release.refusal}` as MessageKey));
  }
  return notes.join(", ");
}

function releasesText(context: CommandContext, list: ReleaseList): string {
  if (!list.available) {
    return context.t("empty.releasesUnavailable");
  }
  if (list.items.length === 0) {
    return context.t("empty.releases");
  }
  return renderTable(
    [
      context.t("col.version"),
      context.t("col.image"),
      context.t("col.commit"),
      context.t("col.by"),
      context.t("col.created"),
      context.t("col.note"),
    ],
    list.items.map((release) => [
      `v${release.number}`,
      release.image,
      release.builtCommit?.slice(0, 7) ?? release.requestedRef ?? "-",
      release.actorEmail ?? "-",
      formatTime(release.createdAt),
      releaseNote(context, release),
    ]),
  );
}

/** The newest kept version older than the running one that can still be gone back to. */
function previousRelease(context: CommandContext, target: ServiceRef, list: ReleaseList): ReleaseEntry {
  const running = list.items.find((release) => release.active);
  if (!list.available || running === undefined) {
    throw usage(context.t("rollback.chooseVersion", { target: label(target) }));
  }
  const earlier = list.items
    .filter((release) => release.number < running.number && release.refusal === null)
    .sort((a, b) => b.number - a.number)[0];
  if (earlier === undefined) {
    throw new ClientError("no_earlier_release", context.t("rollback.none", { target: label(target) }), 409);
  }
  return earlier;
}

/** `5` or `v5`. Whether it can be gone back to is the panel's to say. */
function releaseNamed(context: CommandContext, list: ReleaseList, value: string): ReleaseEntry {
  const match = /^v?(\d+)$/i.exec(value);
  const release = match === null ? undefined : list.items.find((item) => item.number === Number(match[1]));
  if (match === null) {
    throw usage(context.t("usage.version", { value }));
  }
  if (release === undefined) {
    throw new ClientError("not_found", context.t("rollback.unknown", { version: match[1] ?? value }), 404);
  }
  return release;
}

/** One service's variables, or with --project those its project shares with all of its services. */
type EnvScope =
  | { kind: "service"; target: ServiceRef; label: string }
  | { kind: "project"; project: string; label: string };

async function envScopeAt(
  context: CommandContext,
  index: number,
): Promise<{ scope: EnvScope; next: number }> {
  const project = context.flags.project as string | undefined;
  if (project !== undefined) {
    if (namesService(context.positionals[index])) {
      throw usage(context.t("usage.projectAndService"));
    }
    return { scope: { kind: "project", project, label: project }, next: index };
  }
  const { target, next } = await serviceAt(context, index);
  return { scope: { kind: "service", target, label: label(target) }, next };
}

const envNames = (context: CommandContext, scope: EnvScope): Promise<EnvSummary> =>
  scope.kind === "service" ? context.api.serviceEnv(scope.target) : context.api.projectEnv(scope.project);

/** The values, which the panel records in its activity log as read by this key. */
const revealEnv = async (context: CommandContext, scope: EnvScope): Promise<string> =>
  (scope.kind === "service"
    ? await context.api.revealServiceEnv(scope.target)
    : await context.api.revealProjectEnv(scope.project)
  ).env;

const saveEnv = (context: CommandContext, scope: EnvScope, text: string): Promise<EnvSummary> =>
  scope.kind === "service"
    ? context.api.saveServiceEnv(scope.target, text)
    : context.api.saveProjectEnv(scope.project, text);

async function listConfig(context: CommandContext): Promise<CommandResult> {
  const { scope, next } = await envScopeAt(context, 0);
  noMoreArguments(context, next);
  const summary = await envNames(context, scope);
  return {
    data: summary,
    text: () =>
      summary.names.length === 0
        ? context.t("empty.config", { target: scope.label })
        : [...summary.names, context.styles.dim(context.t("config.hidden"))].join("\n"),
  };
}

function namesFrom(context: CommandContext, values: string[]): string[] {
  if (values.length === 0) {
    throw usage(context.t("usage.missingArgument", { name: "<NAME>" }));
  }
  for (const name of values) {
    if (!ENV_NAME.test(name)) {
      throw usage(context.t("usage.envName", { value: name }));
    }
  }
  return [...new Set(values)];
}

/** `NAME=value` pairs, in order. A name given twice keeps its last value. */
function pairsFrom(context: CommandContext, values: string[]): Map<string, string> {
  if (values.length === 0) {
    throw usage(context.t("usage.missingArgument", { name: "<NAME>=<value>" }));
  }
  const pairs = new Map<string, string>();
  for (const pair of values) {
    const separator = pair.indexOf("=");
    const name = separator === -1 ? pair : pair.slice(0, separator);
    if (separator === -1 || !ENV_NAME.test(name)) {
      throw usage(context.t("usage.envPair", { value: pair }));
    }
    const value = pair.slice(separator + 1);
    // The panel keeps one line per variable: a line break would end the value, and start something else.
    if (/[\r\n]/.test(value)) {
      throw usage(context.t("usage.envNewline", { name }));
    }
    pairs.delete(name);
    pairs.set(name, value);
  }
  return pairs;
}

async function changeConfig(context: CommandContext, verb: "get" | "set" | "unset"): Promise<CommandResult> {
  const { t } = context;
  const { scope, next } = await envScopeAt(context, 1);
  const values = context.positionals.slice(next);

  if (verb === "get") {
    const names = namesFrom(context, values);
    requireYes(context, t("confirm.reveal", { target: scope.label }));
    const current = readEnv(await revealEnv(context, scope));
    const missing = names.filter((name) => !current.has(name));
    if (missing.length > 0) {
      throw new ClientError(
        "not_found",
        t("config.notFound", { names: missing.join(", "), target: scope.label }),
        404,
      );
    }
    const found = Object.fromEntries(names.map((name) => [name, current.get(name) ?? ""]));
    return {
      data: found,
      text: () =>
        names.length === 1
          ? (found[names[0] as string] ?? "")
          : names.map((name) => `${name}=${found[name]}`).join("\n"),
    };
  }

  const deploy = context.flags.deploy === true;
  if (deploy && scope.kind === "project") {
    throw usage(t("usage.deployProject"));
  }
  if (context.flags.wait === true && !deploy) {
    throw usage(t("usage.waitWithoutDeploy"));
  }

  const changes = verb === "set" ? pairsFrom(context, values) : undefined;
  const names = verb === "unset" ? namesFrom(context, values) : undefined;
  if (names !== undefined) {
    requireYes(context, t("confirm.unset", { names: names.join(", "), target: scope.label }));
  }

  const before = await revealEnv(context, scope);
  let after: string;
  let message: string;
  if (changes !== undefined) {
    after = setEnv(before, changes);
    message = t("config.saved", { names: [...changes.keys()].join(", "), target: scope.label });
  } else {
    const unset = unsetEnv(before, new Set(names));
    const absent = (names ?? []).filter((name) => !unset.removed.has(name));
    if (absent.length > 0) {
      context.warn(t("config.wasNotSet", { names: absent.join(", "), target: scope.label }));
    }
    after = unset.text;
    message = t("config.removed", { names: [...unset.removed].join(", "), target: scope.label });
  }

  // Nothing to save is not a reason to write anything: the panel would record a change that is none.
  const saved = after === before ? await envNames(context, scope) : await saveEnv(context, scope, after);
  const outcome = after === before ? t("config.unchanged", { target: scope.label }) : message;

  if (deploy && scope.kind === "service") {
    if (context.mode === "text") {
      context.print(outcome);
    }
    stillWanted(context);
    const action = await context.api.deploy(scope.target, { force: false });
    return started(context, action, "deploy.queued", scope.label);
  }
  const hint =
    after === before
      ? undefined
      : scope.kind === "service"
        ? t("config.applyHint", { target: scope.label })
        : t("config.applyHintProject", { project: scope.label });
  return {
    data: saved,
    text: () => (hint === undefined ? outcome : [outcome, context.styles.dim(hint)].join("\n")),
  };
}

async function login(context: CommandContext): Promise<CommandResult> {
  const { t } = context;
  // The address only: a key typed here would show in the process list, and in the error as well.
  if (context.positionals.length > 1) {
    throw usage(t("usage.loginExtra"));
  }
  const address = context.positionals[0] ?? context.env.OPSIFIER_URL?.trim();
  if (address === undefined || address === "") {
    throw usage(t("usage.loginAddress"));
  }
  // Checked before a key is asked for, and never repeated back: it could be a key pasted in its place.
  let panel: string;
  try {
    panel = connectionFromEnv({ OPSIFIER_URL: address, OPSIFIER_API_KEY: "-" }).url.origin;
  } catch {
    throw usage(t("usage.loginAddressInvalid"));
  }
  if (context.flags.web === true) {
    return loginWithBrowser(context, panel);
  }
  let warned = false;
  const check = (apiKey: string) => {
    const connection = connectionFromEnv({ OPSIFIER_URL: panel, OPSIFIER_API_KEY: apiKey });
    if (isExposedOnTheWire(connection.url) && !warned) {
      context.warn(t("warn.plainHttp", { host: connection.url.host }));
      warned = true;
    }
    return context.connect(connection).api.identity();
  };

  const { credentials } = await readCredentials(context.credentialsFile);
  const environmentUrl = context.env.OPSIFIER_URL?.trim();
  const environmentKey = context.env.OPSIFIER_API_KEY?.trim();
  // OPSIFIER_API_KEY belongs to OPSIFIER_URL's panel, and never goes to any other.
  const fromEnvironment =
    environmentKey && environmentUrl && originOf(environmentUrl) === panel ? environmentKey : "";
  const kept = credentials.panels[panel]?.apiKey;

  let apiKey: string | undefined;
  let identity: CallerIdentity | undefined;
  let reused = false;
  if (fromEnvironment !== "") {
    apiKey = fromEnvironment;
    identity = await check(apiKey);
  } else if (kept !== undefined) {
    // Logging in again to a panel whose key is kept makes it current, with nothing to paste, as long
    // as the panel still takes that key.
    try {
      identity = await check(kept);
      apiKey = kept;
      reused = true;
    } catch (error) {
      if (!(error instanceof ClientError && error.status === 401)) {
        throw error;
      }
    }
  }
  if (apiKey === undefined || identity === undefined) {
    apiKey = (await context.readSecret(t("login.prompt", { panel }))).trim();
    if (apiKey === "") {
      throw usage(t("usage.loginKey"));
    }
    // Nothing is kept until the panel itself has accepted the key.
    identity = await check(apiKey);
  }
  // A session from login --web stays: account commands need it, whatever key is kept.
  credentials.panels[panel] = { ...credentials.panels[panel], apiKey };
  credentials.current = panel;
  await writeCredentials(context.credentialsFile, credentials);
  const user = identity.user.email;
  return {
    data: { panel, user, credential: identity.credential, file: context.credentialsFile, reused },
    text: () =>
      [
        t(reused ? "login.reused" : "login.done", { panel, user }),
        context.styles.dim(t("login.kept", { file: context.credentialsFile })),
      ].join("\n"),
  };
}

async function logout(context: CommandContext): Promise<CommandResult> {
  const { t } = context;
  const named = context.positionals[0];
  noMoreArguments(context, 1);
  const { credentials } = await readCredentials(context.credentialsFile);
  const panel = named === undefined ? credentials.current : originOf(named);
  if (panel === null || credentials.panels[panel] === undefined) {
    return {
      data: { panel, removed: false, current: credentials.current },
      text: () => (panel === null ? t("logout.nowhere") : t("logout.none", { panel })),
    };
  }
  const sessionEnded = await endKeptSession(context, panel);
  const hadKey = credentials.panels[panel]?.apiKey !== undefined;
  delete credentials.panels[panel];
  // Never another panel quietly in its place: the next command would act there.
  const wasCurrent = credentials.current === panel;
  if (wasCurrent) {
    credentials.current = null;
  }
  await writeCredentials(context.credentialsFile, credentials);
  const others = Object.keys(credentials.panels);
  return {
    data: { panel, removed: true, sessionEnded, current: credentials.current },
    text: () =>
      [
        t("logout.done", { panel }),
        ...(sessionEnded ? [t("logout.sessionEnded", { panel })] : []),
        ...(hadKey ? [context.styles.dim(t("logout.revoke"))] : []),
        ...(wasCurrent && others.length > 0 ? [t("logout.choose", { panels: others.join(", ") })] : []),
      ].join("\n"),
  };
}

const DATABASE_ENGINES = ["postgres", "mysql", "mariadb", "mongo", "redis"] as const;

/** Creates the project when it is not there yet. True when it had to. */
async function ensureProject(context: CommandContext, name: string): Promise<boolean> {
  try {
    await context.api.project(name);
    return false;
  } catch (error) {
    if (error instanceof ClientError && error.status === 404) {
      await context.api.createProject(name);
      return true;
    }
    throw error;
  }
}

async function create(context: CommandContext): Promise<CommandResult> {
  const { t, flags } = context;
  const value = argument(context, 0, "<project>[/<service>]");
  noMoreArguments(context, 1);
  const image = flags.image as string | undefined;
  const git = flags.git as string | undefined;
  const dockerfilePath = flags.dockerfile as string | undefined;
  const engine = flags.database as string | undefined;
  const sources = [image, git, dockerfilePath, engine].filter((source) => source !== undefined);

  if (!value.includes("/")) {
    if (sources.length > 0 || flags.link === true || flags.deploy === true) {
      throw usage(t("usage.projectOnly", { project: value }));
    }
    const project = await context.api.createProject(value);
    return { data: project, text: () => t("create.project", { project: value }) };
  }

  // Everything that can be wrong with the command line is said before anything is created.
  const target = parseTarget(context, value);
  if (sources.length > 1) {
    throw usage(t("usage.oneSource"));
  }
  if ((flags.ref !== undefined || flags.path !== undefined) && git === undefined) {
    throw usage(t("usage.refWithoutGit"));
  }
  if (engine !== undefined && !(DATABASE_ENGINES as readonly string[]).includes(engine)) {
    throw usage(t("usage.engine", { value: engine, engines: DATABASE_ENGINES.join(", ") }));
  }
  if (flags.deploy === true && sources.length === 0) {
    throw usage(t("usage.deployWithoutSource"));
  }
  if (flags.wait === true && flags.deploy !== true) {
    throw usage(t("usage.waitWithoutDeploy"));
  }
  let dockerfile: string | undefined;
  if (dockerfilePath !== undefined) {
    try {
      dockerfile = await readFile(resolve(context.cwd, dockerfilePath), "utf8");
    } catch (error) {
      throw usage(t("usage.dataFile", { file: dockerfilePath, reason: (error as Error).message }));
    }
  }

  const source: SaveSourceRequest | undefined =
    image !== undefined
      ? { type: "image", image }
      : git !== undefined
        ? {
            type: "git",
            url: git,
            ref: (flags.ref as string | undefined) ?? "main",
            path: (flags.path as string | undefined) ?? "/",
          }
        : dockerfile !== undefined
          ? { type: "dockerfile", dockerfile }
          : undefined;

  const projectCreated = await ensureProject(context, target.project);
  let service: ServiceDetail;
  try {
    service =
      engine !== undefined
        ? await context.api.createDatabase(target, engine as CreateDatabaseRequest["engine"])
        : source !== undefined
          ? await context.api.defineService(target, source)
          : await context.api.createService(target);
  } catch (error) {
    // The panel leaves nothing behind when it refuses a service, and neither does this command: the
    // project it made for it goes too.
    if (projectCreated) {
      await context.api.deleteProject(target.project, target.project).catch(() => undefined);
    }
    throw error;
  }
  if (flags.link === true) {
    await writeLink(context.cwd, { service: label(target), panel: context.client.panelOrigin });
  }

  const done = [
    ...(projectCreated ? [t("create.project", { project: target.project })] : []),
    t(engine === undefined ? "create.service" : "create.database", {
      target: label(target),
      engine: engine ?? "",
    }),
    ...(flags.link === true ? [t("create.linked", { target: label(target) })] : []),
  ];
  if (flags.deploy === true) {
    if (context.mode === "text") {
      context.print(done.join("\n"));
    }
    stillWanted(context);
    return started(
      context,
      await context.api.deploy(target, { force: false }),
      "deploy.queued",
      label(target),
    );
  }
  const next =
    sources.length === 0
      ? t("create.nextPush", { target: label(target) })
      : t("create.nextDeploy", { target: label(target) });
  return { data: service, text: () => [...done, context.styles.dim(next)].join("\n") };
}

/** The panel's own limit on an uploaded archive. */
export const MAX_UPLOAD_BYTES = 1024 ** 3;

/** The archive's name on the panel, from the folder's: something any file system takes. */
const archiveName = (folder: string) =>
  `${
    basename(folder)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+/, "") || "source"
  }.tar.gz`;

/** Stops before the next call to the panel once the person has pressed Ctrl-C. */
function stillWanted(context: CommandContext): void {
  if (context.signal.aborted) {
    throw new ClientError("cancelled", context.t("push.interrupted"));
  }
}

/** True when `folder` is `inner` itself or holds it. */
const holds = (folder: string, inner: string) => inner === folder || inner.startsWith(`${folder}${sep}`);

async function push(context: CommandContext): Promise<CommandResult> {
  const { t, flags } = context;
  const { target, next } = await serviceAt(context, 0);
  noMoreArguments(context, next);
  if (flags.wait === true && flags["upload-only"] === true) {
    throw usage(t("usage.waitWithUploadOnly"));
  }
  // The folder linked to this service as a whole, wherever in it the command runs, the way git pushes
  // a repository. Without such a link, the folder the command runs in.
  const found = await findLink(context.cwd);
  const linked =
    found !== undefined &&
    found.link.service === label(target) &&
    originOf(found.link.panel) === context.client.panelOrigin;
  const folder = resolve(
    context.cwd,
    (flags.dir as string | undefined) ?? (linked ? dirname((found as { file: string }).file) : "."),
  );
  const info = await stat(folder).catch(() => undefined);
  if (info?.isDirectory() !== true) {
    throw usage(t("usage.notAFolder", { folder }));
  }
  // A home folder, the root, or anything above this command line's own keys is never a project.
  if (
    folder === homedir() ||
    folder === parse(folder).root ||
    holds(folder, dirname(context.credentialsFile))
  ) {
    throw usage(t("push.notAProject", { folder }));
  }

  const { source } = await context.api.source(target);
  if (source !== null && source.type !== "upload") {
    requireYes(context, t("confirm.pushReplaces", { target: label(target), source: sourceText(source) }));
  }

  const packed = await packFolder(folder, {
    signal: context.signal,
    exclude: [context.credentialsFile],
    env: context.env,
  });
  if (packed.files === 0) {
    throw usage(t("push.empty", { folder }));
  }
  if (packed.secrets.length > 0) {
    if (flags["include-secrets"] !== true) {
      throw new ClientError(
        "confirmation_required",
        t("push.secretsRefused", { paths: packed.secrets.join(", ") }),
      );
    }
    context.warn(t("push.secretsIncluded", { paths: packed.secrets.join(", ") }));
  }
  if (packed.archive.length > MAX_UPLOAD_BYTES) {
    throw usage(
      t("push.tooLarge", { size: sizeText(packed.archive.length), max: sizeText(MAX_UPLOAD_BYTES) }),
    );
  }
  if (packed.skipped.length > 0) {
    context.warn(t("push.skipped", { paths: packed.skipped.join(", ") }));
  }
  if (context.mode === "text") {
    context.print(
      t("push.packed", {
        files: packed.files,
        size: sizeText(packed.bytes),
        compressed: sizeText(packed.archive.length),
        folder,
      }),
    );
  }

  stillWanted(context);
  const uploaded = await context.api.uploadSource(
    target,
    packed.archive,
    {
      fileName: archiveName(folder),
      // A later push builds from the same folder inside what is sent, unless told otherwise.
      path: (flags.path as string | undefined) ?? (source?.type === "upload" ? source.path : "/"),
    },
    context.signal,
  );
  if (flags["upload-only"] === true) {
    return {
      data: uploaded,
      text: () =>
        [
          t("push.uploaded", { target: label(target) }),
          context.styles.dim(t("push.nextDeploy", { target: label(target) })),
        ].join("\n"),
    };
  }
  if (context.mode === "text") {
    context.print(t("push.uploaded", { target: label(target) }));
  }
  stillWanted(context);
  return started(context, await context.api.deploy(target, { force: false }), "deploy.queued", label(target));
}

function targetText(action: Pick<ActionEntry, "projectName" | "serviceName">): string {
  if (action.projectName === null) {
    return "-";
  }
  return action.serviceName === null ? action.projectName : `${action.projectName}/${action.serviceName}`;
}

function actionsText(context: CommandContext, items: readonly ActionEntry[], empty: MessageKey): string {
  if (items.length === 0) {
    return context.t(empty);
  }
  return renderTable(
    [
      context.t("col.status"),
      context.t("col.action"),
      context.t("col.target"),
      context.t("col.started"),
      context.t("col.id"),
    ],
    items.map((item) => [
      item.status,
      item.type,
      targetText(item),
      formatTime(item.startedAt ?? item.createdAt),
      item.id,
    ]),
  );
}
