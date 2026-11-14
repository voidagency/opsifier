import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ClientError } from "@opsifier/client";

/**
 * What `opsifier login` keeps: one API key per panel, and the panel commands use when nothing else
 * names one. It lives in the user's own configuration folder, readable by that user only.
 */
export interface Credentials {
  current: string | null;
  panels: Record<string, { apiKey: string }>;
}

const EMPTY: Credentials = { current: null, panels: {} };

/** `$XDG_CONFIG_HOME/opsifier`, or `~/.config/opsifier`, or `%APPDATA%\opsifier` on Windows. */
export function credentialsFile(env: Record<string, string | undefined>): string {
  const base =
    env.XDG_CONFIG_HOME?.trim() ||
    (process.platform === "win32" && env.APPDATA?.trim() ? env.APPDATA.trim() : join(homedir(), ".config"));
  return join(base, "opsifier", "credentials.json");
}

export interface StoredCredentials {
  credentials: Credentials;
  /** Set when others than the user can read the file: worth saying, every time. */
  exposed: boolean;
}

export async function readCredentials(file: string): Promise<StoredCredentials> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { credentials: { ...EMPTY, panels: {} }, exposed: false };
    }
    throw error;
  }
  let value: Partial<Credentials> | undefined;
  try {
    value = JSON.parse(text) as Partial<Credentials>;
  } catch {
    value = undefined;
  }
  const panels = value?.panels;
  if (
    panels === undefined ||
    typeof panels !== "object" ||
    panels === null ||
    Object.values(panels).some((panel) => typeof panel?.apiKey !== "string")
  ) {
    throw new ClientError("usage", `${file} is damaged. Remove it, then log in again with opsifier login.`);
  }
  const current = typeof value?.current === "string" && value.current in panels ? value.current : null;
  const mode = process.platform === "win32" ? 0 : (await stat(file)).mode;
  return { credentials: { current, panels }, exposed: (mode & 0o077) !== 0 };
}

/**
 * Written to a file of its own, then moved into place, so that a crash never leaves half a file, and
 * created readable and writable by its owner alone. With no panel left, the file goes.
 */
export async function writeCredentials(file: string, credentials: Credentials): Promise<void> {
  if (Object.keys(credentials.panels).length === 0) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  // A umask cannot loosen what chmod sets afterwards.
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}
