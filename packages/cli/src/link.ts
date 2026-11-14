import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ClientError } from "@opsifier/client";

/** The file `opsifier link` writes: which service a folder deploys to, and on which panel. */
export const LINK_FILE = ".opsifier.json";

export interface LinkRecord {
  /** `project/service`. */
  service: string;
  /** The panel's origin. A link never follows a different OPSIFIER_URL to another panel. */
  panel: string;
}

export interface FoundLink {
  file: string;
  link: LinkRecord;
}

function parseLink(text: string, file: string): LinkRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const record = value as Partial<LinkRecord> | undefined;
  if (typeof record?.service !== "string" || typeof record.panel !== "string") {
    throw new ClientError(
      "usage",
      `${file} is not a link written by opsifier link. Remove it, or link the folder again.`,
    );
  }
  return { service: record.service, panel: record.panel };
}

async function readIfThere(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

/** The nearest link, from this folder up to the root, the way git finds its repository. */
export async function findLink(cwd: string): Promise<FoundLink | undefined> {
  let directory = cwd;
  for (;;) {
    const file = join(directory, LINK_FILE);
    const text = await readIfThere(file);
    if (text !== undefined) {
      return { file, link: parseLink(text, file) };
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

/** Writes the link in this folder, replacing one that was there. It holds no secret. */
export async function writeLink(cwd: string, link: LinkRecord): Promise<string> {
  const file = join(cwd, LINK_FILE);
  await writeFile(file, `${JSON.stringify(link, null, 2)}\n`, "utf8");
  return file;
}

/** Removes the link of this folder only: one further up is left alone. False when there was none. */
export async function removeLink(cwd: string): Promise<{ file: string; removed: boolean }> {
  const file = join(cwd, LINK_FILE);
  const existed = (await readIfThere(file)) !== undefined;
  if (existed) {
    await rm(file);
  }
  return { file, removed: existed };
}
