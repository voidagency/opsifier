import { loadConfig } from "../core/config";
import { createDockerDriver } from "../core/docker";
import { createTools } from "../core/tools";
import { ResetPasswordError, resetPassword } from "../features/access/reset-password";
import { dockerCliEnv } from "../features/service-tabs/source/build/environment";
import { addressRegisteredSince, createSetupAddress, panelHasAccounts } from "./address";
import { runCleanSetup } from "./clean-setup";
import { RestoreError, runRestoreBackup } from "./restore-backup";
import { runRollback } from "./rollback";
import { runSetup, SetupError } from "./setup";

const USAGE = `Usage: opsifier <command> [options]

Commands:
  setup       Install Opsifier on this server, or bring an existing install back in shape.
  clean-setup Show what an interrupted setup made, and with --yes remove it. Nothing else is touched.
  rollback    Go back to the version before the last update, from the outside.
  reset-password   Give an account a new password, printed once. Ends its sessions and API keys.
  restore-backup   Put a server backup back on this server, before setup. install.sh --restore runs it.

Options for reset-password:
  --email <address>        The account. Defaults to the owner.

Options for setup:
  --image <ref>            The image to run the panel from. Defaults to this image.
  --advertise-addr <ip>    The address Swarm advertises. Docker picks one when it can.
  --server-ip <ip>         The address people reach this server on, when it differs, as behind NAT.
  --force                  Replace what is in the way: a service named opsifier or opsifier-traefik
                           that setup did not create, a network named opsifier of the wrong kind,
                           and a Swarm this node can't manage. Without it, those are left alone.
  --help                   Show this.

Options for clean-setup:
  --yes                    Remove what is listed. Without it, this only reports.

Options for restore-backup, which reads RESTIC_REPOSITORY, RESTIC_PASSWORD (the recovery key) and,
for an S3-compatible destination, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_DEFAULT_REGION:
  --snapshot <id>          Which backup. Defaults to the latest.
  --force                  Go ahead on a server whose panel already has accounts. Its state is moved
                           aside, never deleted.
`;

export const COMMANDS = ["setup", "clean-setup", "rollback", "reset-password", "restore-backup"];

interface ParsedArgs {
  force: boolean;
  help: boolean;
  yes?: boolean;
  image?: string;
  advertiseAddr?: string;
  serverIp?: string;
  email?: string;
  snapshot?: string;
}

const VALUE_FLAGS = new Map<string, keyof ParsedArgs>([
  ["--image", "image"],
  ["--advertise-addr", "advertiseAddr"],
  ["--server-ip", "serverIp"],
  ["--email", "email"],
  ["--snapshot", "snapshot"],
]);

/** `--name value` and `--name=value`. Anything unexpected is an error rather than ignored. */
export function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { force: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--force") {
      parsed.force = true;
    } else if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--yes") {
      parsed.yes = true;
    } else {
      const [name = "", inline] = argument.split(/=(.*)/s, 2);
      const key = VALUE_FLAGS.get(name);
      if (key === undefined) {
        throw new SetupError(`Unknown option: ${argument}`);
      }
      const value = inline ?? args[index + 1];
      if (inline === undefined) {
        index += 1;
      }
      if (value === undefined || value === "") {
        throw new SetupError(`${name} needs a value.`);
      }
      Object.assign(parsed, { [key]: value });
    }
  }
  return parsed;
}

function printResult(urls: readonly string[], firstRun: boolean): void {
  console.log("");
  console.log("Opsifier is running.");
  if (urls.length === 0) {
    console.log("Its address could not be worked out: use this server's IP, on port 3000.");
    return;
  }
  console.log(
    firstRun
      ? "Open one of these addresses to create the administrator account. The code in it works once:"
      : "This panel already has an administrator. Sign in at one of these addresses:",
  );
  for (const url of urls) {
    console.log(`  ${url}`);
  }
}

async function setup(args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const image = args.image ?? process.env.OPSIFIER_IMAGE;
  if (image === undefined || image === "") {
    throw new SetupError("Pass --image with the reference of the image to run.");
  }
  const docker = createDockerDriver(config);
  try {
    const result = await runSetup(
      {
        force: args.force,
        advertiseAddr: args.advertiseAddr,
        serverIp: args.serverIp,
        image,
        namesUrl: process.env.OPSIFIER_NAMES_URL?.trim() || undefined,
      },
      {
        docker,
        tools: createTools(config),
        dockerEnv: dockerCliEnv({ config }),
        dataDir: config.dataDir,
        setupTokenFile: config.setupTokenFile,
        log: (line) => console.log(line),
        address: createSetupAddress(config),
      },
    );
    if (result.changed.length === 0) {
      console.log("Nothing needed changing.");
    }
    printResult(result.urls, result.firstRun);
  } finally {
    await docker.dispose();
  }
}

async function cleanSetup(args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const docker = createDockerDriver(config);
  try {
    await runCleanSetup(
      {
        docker,
        dataDir: config.dataDir,
        log: (line) => console.log(line),
        hasAccounts: () => panelHasAccounts(config.databaseFile),
        addressRegisteredSince: (since) => addressRegisteredSince(config, since),
      },
      { confirmed: args.yes === true },
    );
  } finally {
    await docker.dispose();
  }
}

async function rollback(): Promise<void> {
  const config = loadConfig();
  const docker = createDockerDriver(config);
  try {
    await runRollback({ docker, dataDir: config.dataDir, log: (line) => console.log(line) });
  } finally {
    await docker.dispose();
  }
}

async function resetAccountPassword(email: string | undefined): Promise<void> {
  const { email: account, password } = await resetPassword(loadConfig(), email);
  console.log(`New password for ${account}: ${password}`);
  console.log("It is shown once. Every session and API key of this account has ended.");
}

async function restoreBackup(args: ParsedArgs): Promise<void> {
  const config = loadConfig();
  const docker = createDockerDriver(config);
  try {
    await runRestoreBackup(
      { snapshot: args.snapshot ?? "latest", force: args.force },
      {
        tools: createTools(config),
        docker,
        dataDir: config.dataDir,
        databaseFile: config.databaseFile,
        secretKeyFile: config.secretKeyFile,
        env: process.env,
        hasAccounts: () => panelHasAccounts(config.databaseFile),
        log: (line) => console.log(line),
        now: () => Date.now(),
      },
    );
  } finally {
    await docker.dispose();
  }
}

/** Runs one command of the image and reports the outcome through the exit code. */
export async function runCommand(command: string, args: readonly string[]): Promise<number> {
  try {
    const parsed = parseArgs(args);
    if (parsed.help || command === "help" || command === "--help") {
      console.log(USAGE);
      return 0;
    }
    if (command === "setup") {
      await setup(parsed);
    } else if (command === "clean-setup") {
      await cleanSetup(parsed);
    } else if (command === "rollback") {
      await rollback();
    } else if (command === "reset-password") {
      await resetAccountPassword(parsed.email);
    } else if (command === "restore-backup") {
      await restoreBackup(parsed);
    } else {
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
    }
    return 0;
  } catch (error) {
    if (error instanceof SetupError || error instanceof ResetPasswordError || error instanceof RestoreError) {
      console.error(error.message);
      return 1;
    }
    console.error(error);
    return 1;
  }
}
