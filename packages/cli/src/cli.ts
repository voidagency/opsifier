import { parseArgs } from "node:util";
import {
  ClientError,
  connectionFromEnv,
  errorDocument,
  hintFor,
  isExposedOnTheWire,
  type Locale,
  PanelClient,
  panelApi,
} from "@opsifier/client";
import pkg from "../package.json" with { type: "json" };
import { COMMANDS, type Command, type CommandContext, type CommandResult, type OptionSpec } from "./commands";
import { createStyles } from "./format";
import { localeFrom, type Translate, translator } from "./messages";

export interface CliRuntime {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Whether stdout is a terminal: text for a person, JSON for everything else. */
  isTTY: boolean;
  signal: AbortSignal;
  /** Everything between the CLI and the panel goes through this. Replaceable in tests only. */
  fetch?: typeof fetch;
  readStdin?: () => Promise<string>;
}

const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  json: { type: "boolean", description: "flag.json" },
  text: { type: "boolean", description: "flag.text" },
  help: { type: "boolean", short: "h", description: "flag.help" },
};

const usageLine = (command: Command, t: Translate) =>
  `  ${`${command.name} ${command.args}`.trim().padEnd(46)} ${t(`cmd.${command.name}` as Parameters<Translate>[0])}`;

function generalHelp(t: Translate): string {
  const everyday = COMMANDS.filter((command) => command.group === "everyday");
  const other = COMMANDS.filter((command) => command.group === "other");
  return [
    t("help.title"),
    "",
    t("help.usage"),
    "",
    `${t("help.everyday")}:`,
    ...everyday.map((command) => usageLine(command, t)),
    "",
    `${t("help.longTail")}:`,
    ...other.map((command) => usageLine(command, t)),
    "",
    `${t("help.environment")}:`,
    `  OPSIFIER_URL      ${t("help.env.url")}`,
    `  OPSIFIER_API_KEY  ${t("help.env.key")}`,
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
    runtime.stderr(`${JSON.stringify(errorDocument(error, locale))}\n`);
    return;
  }
  const lines = [`${t("error.prefix")}: ${error.message}`];
  for (const [field, message] of Object.entries(error.fields ?? {})) {
    lines.push(`  ${field}: ${message}`);
  }
  const hint = hintFor(error, locale);
  if (hint !== undefined) {
    lines.push(`${t("error.hint")}: ${hint}`);
  }
  runtime.stderr(`${lines.join("\n")}\n`);
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

    const connection = connectionFromEnv(runtime.env);
    if (isExposedOnTheWire(connection.url) && mode === "text") {
      runtime.stderr(`${t("warn.plainHttp", { host: connection.url.host })}\n`);
    }
    const client = new PanelClient(connection, runtime.fetch);
    const styles = createStyles(mode === "text" && runtime.isTTY && runtime.env.NO_COLOR === undefined);
    const context: CommandContext = {
      api: panelApi(client),
      client,
      positionals: parsed.positionals,
      flags: parsed.values as CommandContext["flags"],
      t,
      styles,
      mode,
      env: runtime.env,
      print: (text) => runtime.stdout(`${text}\n`),
      warn: (text) => runtime.stderr(`${text}\n`),
      signal: runtime.signal,
      readStdin: runtime.readStdin ?? (async () => ""),
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
