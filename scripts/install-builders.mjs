#!/usr/bin/env node
// Installs every builder version the panel offers into the image. The list lives in the contract,
// so the image can't offer a version it does not have.
//
//   node scripts/install-builders.mjs <source.ts> <builders-dir> <bin-dir> <amd64|arm64>
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const [sourceFile, buildersDir, binDir, arch] = process.argv.slice(2);

if (arch !== "amd64" && arch !== "arm64") {
  console.error("Usage: install-builders.mjs <source.ts> <builders-dir> <bin-dir> <amd64|arm64>");
  process.exit(2);
}

const source = await readFile(sourceFile, "utf8");

function versions(name) {
  const body = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source)?.[1];
  const found = [...(body ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (found.length === 0) {
    throw new Error(`No versions found for ${name} in ${sourceFile}.`);
  }
  return found;
}

function single(name) {
  const value = new RegExp(`${name}\\s*=\\s*"([^"]+)"`).exec(source)?.[1];
  if (value === undefined) {
    throw new Error(`No version found for ${name} in ${sourceFile}.`);
  }
  return value;
}

/** A checksum published beside the file. Not every release has one, so its absence is not fatal. */
async function publishedChecksum(url, fileName) {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  for (const line of (await response.text()).split("\n")) {
    const [sum, name] = line.trim().split(/\s+/);
    if (name?.replace(/^\*/, "") === fileName || (name === undefined && /^[0-9a-f]{64}$/.test(sum ?? ""))) {
      return sum;
    }
  }
  return null;
}

async function download(url, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) {
      return Buffer.from(await response.arrayBuffer());
    }
    if (attempt >= attempts) {
      throw new Error(`GET ${url}: ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}

/** Puts one file of a tar.gz at `target`, after checking the archive against its checksum. */
async function install(url, checksumUrl, member, target) {
  const scratch = await mkdtemp(join(tmpdir(), "builder-"));
  try {
    const archive = await download(url);
    const fileName = url.slice(url.lastIndexOf("/") + 1);
    const expected = checksumUrl === null ? null : await publishedChecksum(checksumUrl, fileName);
    const actual = createHash("sha256").update(archive).digest("hex");
    if (expected !== null && expected !== actual) {
      throw new Error(`Checksum mismatch for ${fileName}: expected ${expected}, got ${actual}.`);
    }
    if (expected === null) {
      console.log(`no published checksum for ${fileName}`);
    }
    const file = join(scratch, "archive.tar.gz");
    await writeFile(file, archive);
    await run("tar", ["-xzf", file, "-C", scratch]);
    await mkdir(join(target, ".."), { recursive: true });
    await run("cp", [join(scratch, member), target]);
    await chmod(target, 0o755);
    console.log(`installed ${target}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function eachLimited(items, limit, work) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        await work(item);
      }
    }),
  );
}

const nixpacksArch = arch === "amd64" ? "x86_64" : "aarch64";
const railpackArch = arch === "amd64" ? "x86_64" : "arm64";

await eachLimited(versions("nixpacksVersions"), 3, (version) => {
  const name = `nixpacks-v${version}-${nixpacksArch}-unknown-linux-musl.tar.gz`;
  const base = `https://github.com/railwayapp/nixpacks/releases/download/v${version}`;
  return install(
    `${base}/${name}`,
    `${base}/checksums.txt`,
    "nixpacks",
    join(buildersDir, "nixpacks", version, "nixpacks"),
  );
});

await eachLimited(versions("railpackVersions"), 3, (version) => {
  const name = `railpack-v${version}-${railpackArch}-unknown-linux-musl.tar.gz`;
  const base = `https://github.com/railwayapp/railpack/releases/download/v${version}`;
  return install(
    `${base}/${name}`,
    `${base}/checksums.txt`,
    "railpack",
    join(buildersDir, "railpack", version, "railpack"),
  );
});

const packVersion = single("packVersion");
const packName = `pack-v${packVersion}-linux${arch === "arm64" ? "-arm64" : ""}.tgz`;
const packBase = `https://github.com/buildpacks/pack/releases/download/v${packVersion}`;
await install(`${packBase}/${packName}`, `${packBase}/${packName}.sha256`, "pack", join(binDir, "pack"));
