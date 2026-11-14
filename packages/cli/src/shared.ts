import type { Connection, PanelApi, PanelClient, ServiceRef } from "@opsifier/client";
import { ClientError } from "@opsifier/client";
import type { ActionEntry } from "@opsifier/contract";
import type { Styles } from "./format";
import { findLink } from "./link";
import type { MessageKey, Translate } from "./messages";
import { waitForAction } from "./wait";

/**
 * What every command shares: its context, how it finds the service it acts on, how it asks for
 * confirmation, and how it reports work the panel has taken on.
 */

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
  /** The folder the command runs in, where a link is looked for. */
  cwd: string;
  /** Where `opsifier login` keeps keys. */
  credentialsFile: string;
  /** A client for another panel or key than the command's own: what login checks a key with. */
  connect(connection: Connection): { client: PanelClient; api: PanelApi };
  /** Asks for a secret without showing it as it is typed, or reads it from standard input. */
  readSecret(prompt: string): Promise<string>;
  print(text: string): void;
  /** Prints without adding a line break: an action's output arrives in pieces. */
  write(text: string): void;
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
  /** Where the general help lists it. Hidden commands serve the completion scripts only. */
  group: "setup" | "everyday" | "other" | "hidden";
  args: string;
  /** Other forms of the same command, shown under its usage. */
  more?: string[];
  /** Words that may come first, such as `set` in `config set`: what completion offers there. */
  verbs?: string[];
  options?: Record<string, OptionSpec>;
  /** Needs no panel at all, so it runs without OPSIFIER_URL and OPSIFIER_API_KEY. */
  offline?: boolean;
  run(context: CommandContext): Promise<CommandResult | undefined>;
}

export const usage = (message: string) => new ClientError("usage", message);

/** A positional that names a service: `project/service`, never a `NAME=value` pair nor an address. */
export const namesService = (value: string | undefined): value is string =>
  value?.includes("/") === true && !value.includes("=") && !value.includes("://");

/** `source` says where the value came from when it was not typed on this command line. */
export function parseTarget(context: CommandContext, value: string, source?: string): ServiceRef {
  const [project, service, ...rest] = value.split("/");
  if (project === undefined || project === "" || service === undefined || service === "" || rest.length > 0) {
    throw usage(
      source === undefined
        ? context.t("usage.target", { value })
        : context.t("usage.targetFrom", { value, source }),
    );
  }
  return { project, service };
}

/** A service that has to be named on the command line: for what can't be taken back. */
export function targetOf(context: CommandContext): ServiceRef {
  return parseTarget(context, argument(context, 0, "<project>/<service>"));
}

export function originOf(address: string): string {
  try {
    return new URL(address).origin;
  } catch {
    return address;
  }
}

/**
 * The service a command acts on: named at `index`, or else OPSIFIER_SERVICE, or else the link of this
 * folder or of the nearest folder above it. `next` is where the command's other arguments start.
 */
export async function serviceAt(
  context: CommandContext,
  index: number,
): Promise<{ target: ServiceRef; next: number; linkFile?: string }> {
  const named = context.positionals[index];
  if (namesService(named)) {
    return { target: parseTarget(context, named), next: index + 1 };
  }
  const fromEnvironment = context.env.OPSIFIER_SERVICE?.trim();
  if (fromEnvironment !== undefined && fromEnvironment !== "") {
    return { target: parseTarget(context, fromEnvironment, "OPSIFIER_SERVICE"), next: index };
  }
  const found = await findLink(context.cwd);
  if (found === undefined) {
    throw usage(context.t("usage.noTarget"));
  }
  // A folder linked to a service on one panel never deploys to whatever OPSIFIER_URL names today.
  if (originOf(found.link.panel) !== context.client.panelOrigin) {
    throw usage(
      context.t("usage.linkPanel", {
        file: found.file,
        service: found.link.service,
        panel: found.link.panel,
        current: context.client.panelOrigin,
      }),
    );
  }
  return { target: parseTarget(context, found.link.service, found.file), next: index, linkFile: found.file };
}

export function argument(context: CommandContext, index: number, name: string): string {
  const value = context.positionals[index];
  if (value === undefined) {
    throw usage(context.t("usage.missingArgument", { name }));
  }
  return value;
}

export function noMoreArguments(context: CommandContext, count: number): void {
  const extra = context.positionals[count];
  if (extra !== undefined) {
    throw usage(context.t("usage.extraArgument", { value: extra }));
  }
}

export const label = (target: ServiceRef) => `${target.project}/${target.service}`;

export function requireYes(context: CommandContext, message: string): void {
  if (context.flags.yes !== true) {
    throw new ClientError("confirmation_required", message);
  }
}

export function confirmValue(context: CommandContext, message: string): string {
  const value = context.flags.confirm;
  if (typeof value !== "string" || value === "") {
    throw new ClientError("confirmation_required", message);
  }
  return value;
}

/** The result of starting something slow: what was queued, and how to look at it next. */
export function queued(
  context: CommandContext,
  action: ActionEntry,
  key: MessageKey,
  target: string,
  params: Record<string, string | number> = {},
): CommandResult {
  return {
    data: action,
    text: () =>
      [
        context.t(key, { target, project: target, action: action.id, status: action.status, ...params }),
        context.styles.dim(context.t("next.check", { action: action.id })),
      ].join("\n"),
  };
}

/** Returns once the panel has taken the action on, or, with --wait, once it has ended. */
export function started(
  context: CommandContext,
  action: ActionEntry,
  key: MessageKey,
  target: string,
  params: Record<string, string | number> = {},
): Promise<CommandResult> | CommandResult {
  return context.flags.wait === true
    ? waitForAction(context, action, target)
    : queued(context, action, key, target, params);
}

export const waitOption: Record<string, OptionSpec> = {
  wait: { type: "boolean", short: "w", description: "flag.wait" },
};

/** Where a service comes from, in a few words: `image nginx:1.27`, `git https://…`. */
export function sourceText(source: unknown): string {
  const value = source as {
    type?: string;
    image?: string;
    repository?: string;
    url?: string;
    owner?: string;
    repo?: string;
  } | null;
  if (value === null || value?.type === undefined) {
    return "-";
  }
  return `${value.type} ${value.image ?? value.repository ?? value.url ?? (value.owner ? `${value.owner}/${value.repo}` : "")}`.trim();
}
