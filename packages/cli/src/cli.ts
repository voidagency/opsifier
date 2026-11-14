import { parseArgs } from "node:util";
import {
  ClientError,
  type Connection,
  connectionFromEnv,
  errorDocument,
  hintFor,
  isExposedOnTheWire,
  type Locale,
  PanelClient,
  panelApi,
} from "@opsifier/client";
import pkg from "../package.json" with { type: "json" };
import { sessionConnection, sessionIsLive } from "./accounts";
import {
  COMMANDS,
  type Command,
  type CommandContext,
  type CommandResult,
  type GLOBAL_FLAGS,
  type OptionSpec,
} from "./commands";
import { credentialsFile, readCredentials } from "./credentials";
import { createStyles } from "./format";
import { findLink } from "./link";
import { localeFrom, type MessageKey, type Translate, translator } from "./messages";

export interface CliRuntime {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Whether stdout is a terminal: text for a person, JSON for everything else. */
  isTTY: boolean;
  signal: AbortSignal;
  /** Where the command runs, and where a folder's link is looked for. The process's own by default. */
  cwd?: string;
  /** Everything between the CLI and the panel goes through this. Replaceable in tests only. */
  fetch?: typeof fetch;
  readStdin?: () => Promise<string>;
  /** Asks for a secret without showing it as it is typed. Reads standard input when not given. */
  readSecret?: (prompt: string) => Promise<string>;
  /** Where `opsifier login` keeps keys. The user's configuration folder by default. */
  credentialsFile?: string;
}

/** Keyed by GLOBAL_FLAGS, so that the completion scripts offer exactly these. */
const GLOBAL_OPTIONS: Record<(typeof GLOBAL_FLAGS)[number], OptionSpec> = {
  json: { type: "boolean", description: "flag.json" },
  text: { type: "boolean", description: "flag.text" },
  help: { type: "boolean", short: "h", description: "flag.help" },
};

const usageLine = (command: Command, t: Translate) =>
  `  ${`${command.name} ${command.args}`.trim().padEnd(46)} ${t(`cmd.${command.name}` as Parameters<Translate>[0])}`;

function generalHelp(t: Translate): string {
  const group = (name: Command["group"]) =>
    COMMANDS.filter((command) => command.group === name).map((command) => usageLine(command, t));
  return [
    t("help.title"),
    "",
    t("help.usage"),
    "",
    `${t("help.setup")}:`,
    ...group("setup"),
    "",
    `${t("help.everyday")}:`,
    ...group("everyday"),
    "",
    `${t("help.longTail")}:`,
    ...group("other"),
    "",
    `${t("help.environment")}:`,
    `  OPSIFIER_URL      ${t("help.env.url")}`,
    `  OPSIFIER_API_KEY  ${t("help.env.key")}`,
    `  OPSIFIER_SERVICE  ${t("help.env.service")}`,
    t("help.login"),
    "",
    t("help.target"),
    "",
    t("help.outputNote"),
    t("help.exitCodes"),
    t("help.more"),
  ].join("\n");
}

function commandHelp(command: Command, t: Translate): string {
  const lines = [
    `opsifier ${command.name} ${command.args}`.trim(),
    ...(command.more ?? []).map((form) => `opsifier ${form}`),
    t(`cmd.${command.name}` as Parameters<Translate>[0]),
    "",
    `${t("help.options")}:`,
  ];
  for (const [name, option] of Object.entries({ ...command.options, ...GLOBAL_OPTIONS })) {
    const flag = `${option.short === undefined ? "    " : `-${option.short}, `}--${name}${option.type === "string" ? " <value>" : ""}`;
    lines.push(`  ${flag.padEnd(24)} ${t(option.description)}`);
  }
  return lines.join("\n");
}

/** Fails loudly on a mistyped flag: an agent or a script needs to find out at once, not silently. */
function parseCommandArgs(command: Command, args: string[], t: Translate) {
  const options = { ...command.options, ...GLOBAL_OPTIONS };
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries(
        Object.entries(options).map(([name, { type, short, multiple }]) => [
          name,
          { type, ...(short === undefined ? {} : { short }), ...(multiple === true ? { multiple } : {}) },
        ]),
      ),
    });
  } catch (error) {
    const message = (error as Error).message.split(". ")[0] ?? "";
    if (/--(api-?key|key|token|secret)\b/i.test(message)) {
      throw new ClientError("usage", t("usage.keyFlag"));
    }
    throw new ClientError("usage", `${message}. opsifier ${command.name} --help`);
  }
}

export function exitCodeFor(error: ClientError): number {
  if (error.code === "cancelled") {
    return 130;
  }
  // The panel answered every call: what it was asked to do ran, and failed there. Or something failed
  // on this machine, such as a file that can't be read: asking the panel again would change nothing.
  if (error.code === "action_failed" || error.code === "internal_error") {
    return 1;
  }
  if (error.code === "usage" || error.code === "confirmation_required" || error.code === "invalid_path") {
    return 2;
  }
  if (error.code === "not_configured" || error.status === 401) {
    return 3;
  }
  if (error.status === 403) {
    return 4;
  }
  if (error.status === 404) {
    return 5;
  }
  if (error.status === 409) {
    return 6;
  }
  if (error.status === 400 || error.code === "invalid_url") {
    return 2;
  }
  if (error.status === undefined || error.code === "not_json") {
    return 7;
  }
  return 1;
}

function report(
  error: ClientError,
  mode: "json" | "text",
  runtime: CliRuntime,
  locale: Locale,
  t: Translate,
): void {
  if (mode === "json") {
    const document = errorDocument(error, locale);
    const hint = cliHint(error, t);
    if (hint !== undefined) {
      document.error.hint = hint;
    }
    runtime.stderr(`${JSON.stringify(document)}\n`);
    return;
  }
  const lines = [`${t("error.prefix")}: ${error.message}`];
  for (const [field, message] of Object.entries(error.fields ?? {})) {
    lines.push(`  ${field}: ${message}`);
  }
  const hint = cliHint(error, t) ?? hintFor(error, locale);
  if (hint !== undefined) {
    lines.push(`${t("error.hint")}: ${hint}`);
  }
  runtime.stderr(`${lines.join("\n")}\n`);
}

/** Where the command line knows better than the shared client: it can also log in. */
const CLI_HINTS: Partial<Record<string, MessageKey>> = { not_configured: "hint.notConfigured" };

function cliHint(error: ClientError, t: Translate): string | undefined {
  const key = CLI_HINTS[error.code];
  return key === undefined ? undefined : t(key);
}

const originOf = (address: string): string | undefined => {
  try {
    return new URL(address).origin;
  } catch {
    return undefined;
  }
};

/**
 * The panel and key a command talks to: OPSIFIER_URL with OPSIFIER_API_KEY when both are set, else a key
 * kept by `opsifier login`: for OPSIFIER_URL's panel, then for the panel this folder is linked to, then
 * for the panel logged in to last.
 */
async function connectionFor(
  runtime: CliRuntime,
  file: string,
  cwd: string,
  t: Translate,
): Promise<Connection> {
  const address = runtime.env.OPSIFIER_URL?.trim();
  const key = runtime.env.OPSIFIER_API_KEY?.trim();
  if (address && key) {
    return connectionFromEnv(runtime.env);
  }
  if (key) {
    // A key alone could end up sent to whichever panel was logged in to last.
    throw new ClientError("not_configured", t("auth.keyWithoutUrl"));
  }
  const { credentials, exposed } = await readCredentials(file);
  if (exposed) {
    runtime.stderr(`${t("warn.credentialsExposed", { file })}\n`);
  }
  let panel: string | undefined;
  if (address) {
    // Says what is wrong with the address itself before anything is looked up for it.
    panel = connectionFromEnv({ OPSIFIER_URL: address, OPSIFIER_API_KEY: "-" }).url.origin;
  } else {
    const link = await findLink(cwd);
    const linked = link === undefined ? undefined : originOf(link.link.panel);
    panel =
      linked !== undefined && credentials.panels[linked] !== undefined
        ? linked
        : (credentials.current ?? undefined);
  }
  if (panel === undefined) {
    throw new ClientError("not_configured", t("auth.none"));
  }
  const stored = credentials.panels[panel];
  if (stored === undefined) {
    throw new ClientError("not_configured", t("auth.noKeyFor", { panel }));
  }
  if (stored.apiKey !== undefined) {
    return connectionFromEnv({ OPSIFIER_URL: address || panel, OPSIFIER_API_KEY: stored.apiKey });
  }
  // Signed in with `login --web` alone: the person's session does the rest as well.
  if (stored.session !== undefined && sessionIsLive(stored.session)) {
    return sessionConnection(address || panel, stored.session.token);
  }
  throw new ClientError("not_configured", t("auth.sessionEnded", { panel }));
}

/** Stands in for the panel in a command that needs none: reaching for it anyway is a bug, said loudly. */
function noPanel<T extends object>(): T {
  return new Proxy({} as T, {
    get() {
      throw new ClientError(
        "internal_error",
        "This command was declared offline, and still asked for the panel.",
      );
    },
  });
}

/** Runs one command line and says how it ended. Everything it touches comes in through `runtime`. */
export async function runCli(argv: readonly string[], runtime: CliRuntime): Promise<number> {
  const locale = localeFrom(runtime.env);
  const t = translator(locale);
  // Read before parsing, so that even a usage error comes out in the requested format.
  const mode: "json" | "text" = argv.includes("--json")
    ? "json"
    : argv.includes("--text")
      ? "text"
      : runtime.isTTY
        ? "text"
        : "json";

  try {
    const [name, ...rest] = argv;
    if (name === undefined || name === "help" || name === "--help" || name === "-h") {
      const command = name === "help" ? COMMANDS.find((candidate) => candidate.name === rest[0]) : undefined;
      runtime.stdout(`${command === undefined ? generalHelp(t) : commandHelp(command, t)}\n`);
      return 0;
    }
    if (name === "--version" || name === "-v") {
      runtime.stdout(`${pkg.version}\n`);
      return 0;
    }

    const command = COMMANDS.find((candidate) => candidate.name === name);
    if (command === undefined) {
      throw new ClientError("usage", t("usage.unknownCommand", { name }));
    }

    const parsed = parseCommandArgs(command, rest, t);
    if (parsed.values.help === true) {
      runtime.stdout(`${commandHelp(command, t)}\n`);
      return 0;
    }

    const cwd = runtime.cwd ?? process.cwd();
    const file = runtime.credentialsFile ?? credentialsFile(runtime.env);
    let client: PanelClient | undefined;
    if (command.offline !== true) {
      const connection = await connectionFor(runtime, file, cwd, t);
      if (isExposedOnTheWire(connection.url) && mode === "text") {
        runtime.stderr(`${t("warn.plainHttp", { host: connection.url.host })}\n`);
      }
      client = new PanelClient(connection, runtime.fetch);
    }
    const readStdin = runtime.readStdin ?? (async () => "");
    const styles = createStyles(mode === "text" && runtime.isTTY && runtime.env.NO_COLOR === undefined);
    const context: CommandContext = {
      api: client === undefined ? noPanel<CommandContext["api"]>() : panelApi(client),
      client: client ?? noPanel<PanelClient>(),
      positionals: parsed.positionals,
      flags: parsed.values as CommandContext["flags"],
      t,
      styles,
      mode,
      env: runtime.env,
      cwd,
      credentialsFile: file,
      connect: (connection) => {
        const other = new PanelClient(connection, runtime.fetch);
        return { client: other, api: panelApi(other) };
      },
      print: (text) => runtime.stdout(`${text}\n`),
      write: (text) => runtime.stdout(text),
      warn: (text) => runtime.stderr(`${text}\n`),
      signal: runtime.signal,
      readStdin,
      readSecret: runtime.readSecret ?? (async () => (await readStdin()).split(/\r?\n/)[0] ?? ""),
    };

    const result: CommandResult | undefined = await command.run(context);
    if (result !== undefined) {
      runtime.stdout(`${mode === "json" ? JSON.stringify(result.data, null, 2) : result.text()}\n`);
    }
    return 0;
  } catch (error) {
    const known =
      error instanceof ClientError
        ? error
        : new ClientError("internal_error", error instanceof Error ? error.message : String(error));
    report(known, mode, runtime, locale, t);
    return exitCodeFor(known);
  }
}
