import { readFile } from "node:fs/promises";
import type { PanelApi, PanelClient, ServiceRef } from "@opsifier/client";
import {
  buildCatalogue,
  ClientError,
  classifyOperation,
  describeOperation,
  fetchOpenApiDocument,
  normalizeApiPath,
} from "@opsifier/client";
import type {
  ActionEntry,
  LogSearchQuery,
  ProjectSummary,
  ServiceLogLine,
  ServiceStatus,
  ServiceSummary,
} from "@opsifier/contract";
import { bySeverity, formatTime, renderFields, renderTable, type Styles, WAKE_MARK } from "./format";
import type { MessageKey, Translate } from "./messages";

export interface OptionSpec {
  type: "boolean" | "string";
  short?: string;
  multiple?: boolean;
  description: MessageKey;
}

export interface CommandContext {
  api: PanelApi;
  client: PanelClient;
  positionals: string[];
  flags: Record<string, string | boolean | string[] | undefined>;
  t: Translate;
  styles: Styles;
  mode: "json" | "text";
  env: Record<string, string | undefined>;
  print(text: string): void;
  warn(text: string): void;
  signal: AbortSignal;
  readStdin(): Promise<string>;
}

/** `data` is printed in JSON mode, as the API answered it. `text` is for a person. */
export interface CommandResult {
  data: unknown;
  text: () => string;
}

export interface Command {
  name: string;
  group: "everyday" | "other";
  args: string;
  /** Other forms of the same command, shown under its usage. */
  more?: string[];
  options?: Record<string, OptionSpec>;
  run(context: CommandContext): Promise<CommandResult | undefined>;
}

const usage = (message: string) => new ClientError("usage", message);

function targetOf(context: CommandContext): ServiceRef {
  const value = argument(context, 0, "<project>/<service>");
  const [project, service, ...rest] = value.split("/");
  if (project === undefined || project === "" || service === undefined || service === "" || rest.length > 0) {
    throw usage(context.t("usage.target", { value }));
  }
  return { project, service };
}

function argument(context: CommandContext, index: number, name: string): string {
  const value = context.positionals[index];
  if (value === undefined) {
    throw usage(context.t("usage.missingArgument", { name }));
  }
  return value;
}

function noMoreArguments(context: CommandContext, count: number): void {
  const extra = context.positionals[count];
  if (extra !== undefined) {
    throw usage(context.t("usage.extraArgument", { value: extra }));
  }
}

const label = (target: ServiceRef) => `${target.project}/${target.service}`;

function requireYes(context: CommandContext, message: string): void {
  if (context.flags.yes !== true) {
    throw new ClientError("confirmation_required", message);
  }
}

function confirmValue(context: CommandContext, message: string): string {
  const value = context.flags.confirm;
  if (typeof value !== "string" || value === "") {
    throw new ClientError("confirmation_required", message);
  }
  return value;
}

/** The result of starting something slow: what was queued, and how to look at it next. */
function queued(
  context: CommandContext,
  action: ActionEntry,
  key: MessageKey,
  target: string,
): CommandResult {
  return {
    data: action,
    text: () =>
      [
        context.t(key, { target, project: target, action: action.id, status: action.status }),
        context.styles.dim(context.t("next.check", { action: action.id })),
      ].join("\n"),
  };
}

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

function sourceText(source: unknown): string {
  const value = source as {
    type?: string;
    image?: string;
    repository?: string;
    owner?: string;
    repo?: string;
  } | null;
  if (value === null || value?.type === undefined) {
    return "-";
  }
  return `${value.type} ${value.image ?? value.repository ?? (value.owner ? `${value.owner}/${value.repo}` : "")}`.trim();
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

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      return resolve();
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

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

export const COMMANDS: readonly Command[] = [
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
    args: "<project>/<service>",
    options: logOptions,
    async run(context) {
      const target = targetOf(context);
      noMoreArguments(context, 1);
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
    args: "<project>/<service>",
    options: { limit: { type: "string", short: "n", description: "flag.limit" } },
    async run(context) {
      const target = targetOf(context);
      noMoreArguments(context, 1);
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
    args: "<project>/<service>",
    options: { force: { type: "boolean", description: "flag.force" } },
    async run(context) {
      const target = targetOf(context);
      noMoreArguments(context, 1);
      const action = await context.api.deploy(target, { force: context.flags.force === true });
      return queued(context, action, "deploy.queued", label(target));
    },
  },
  {
    name: "restart",
    group: "everyday",
    args: "<project>/<service>",
    async run(context) {
      const target = targetOf(context);
      noMoreArguments(context, 1);
      return queued(context, await context.api.restart(target), "restart.queued", label(target));
    },
  },
  {
    name: "start",
    group: "everyday",
    args: "<project>/<service>",
    async run(context) {
      const target = targetOf(context);
      noMoreArguments(context, 1);
      return queued(context, await context.api.start(target), "start.queued", label(target));
    },
  },
  {
    name: "stop",
    group: "everyday",
    args: "<project>/<service>",
    options: { yes: { type: "boolean", short: "y", description: "flag.yes" } },
    async run(context) {
      const target = targetOf(context);
      noMoreArguments(context, 1);
      requireYes(context, context.t("confirm.stop", { target: label(target) }));
      return queued(context, await context.api.stop(target), "stop.queued", label(target));
    },
  },
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
