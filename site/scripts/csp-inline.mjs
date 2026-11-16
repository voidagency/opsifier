// Astro hashes the scripts it bundles into each page's Content-Security-Policy, but not the few that
// components write inline as they are, such as the documentation's theme switch. This adds their
// hashes, page by page, after the build: only scripts that are in a page when it is built can run.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const META = /<meta http-equiv="content-security-policy" content="([^"]*)">/i;
const INLINE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
/** Only these run as scripts; JSON-LD and other data blocks never execute. */
const RUNS = /^(|text\/javascript|application\/javascript|module)$/i;

async function* pages(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      yield* pages(path);
    } else if (entry.name.endsWith(".html")) {
      yield path;
    }
  }
}

let changed = 0;
for await (const page of pages(DIST)) {
  const html = await readFile(page, "utf8");
  const meta = META.exec(html);
  if (meta === null) {
    continue;
  }
  const hashes = new Set();
  for (const [, attributes, body] of html.matchAll(INLINE)) {
    const type = /\btype="([^"]*)"/i.exec(attributes)?.[1] ?? "";
    if (/\bsrc=/i.test(attributes) || !RUNS.test(type) || body.trim() === "") {
      continue;
    }
    hashes.add(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
  const policy = meta[1].replace(/&#39;/g, "'");
  const directives = policy.split(";").map((part) => part.trim());
  const index = directives.findIndex((part) => part.startsWith("script-src"));
  if (index === -1) {
    continue;
  }
  const missing = [...hashes].filter((hash) => !directives[index].split(/\s+/).includes(hash));
  if (missing.length === 0) {
    continue;
  }
  directives[index] = `${directives[index]} ${missing.join(" ")}`;
  const content = directives.filter((part) => part !== "").join("; ");
  await writeFile(page, html.replace(meta[0], `<meta http-equiv="content-security-policy" content="${content}">`));
  changed += 1;
}
console.log(`Inline script hashes added to ${changed} pages`);
