// Publishes the repository's guides, docs/*.md, as the site's /docs/ pages. The repository stays the
// one place they are written: this runs before every build, and what it writes is never committed.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(SITE, "..", "docs");
const TARGET = join(SITE, "src", "content", "docs", "docs");
const REPOSITORY = "https://github.com/voidagency/opsifier";

/** README.md is the section's first page; every other guide is named after its file. */
const slugOf = (file) => (file === "README.md" ? "" : file.replace(/\.md$/, "").toLowerCase());
const pathOf = (file) => `/docs/${slugOf(file) === "" ? "" : `${slugOf(file)}/`}`;

/** The first paragraph, as plain text, for the page's description. */
function describe(body) {
  const paragraph = body
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block !== "" && !/^[#>|`-]/.test(block));
  const plain = (paragraph ?? "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*`_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 200 ? `${plain.slice(0, 197).replace(/\s+\S*$/, "")}…` : plain;
}

/** Links between guides become links between pages; anything else in the repository opens on GitHub. */
function relink(body, guides) {
  return body.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    if (/^[a-z]+:|^#|^\//i.test(target)) {
      return whole;
    }
    const [file, anchor] = target.split("#");
    if (guides.has(file)) {
      return `](${pathOf(file)}${anchor === undefined ? "" : `#${anchor}`})`;
    }
    return `](${REPOSITORY}/blob/main/docs/${target})`;
  });
}

const yaml = (value) => JSON.stringify(value);

const files = (await readdir(SOURCE)).filter((file) => file.endsWith(".md")).sort();
const guides = new Set(files);
await rm(TARGET, { recursive: true, force: true });
await mkdir(TARGET, { recursive: true });

for (const file of files) {
  const text = await readFile(join(SOURCE, file), "utf8");
  const heading = /^#\s+(.+)$/m.exec(text);
  if (heading === null) {
    throw new Error(`${file} has no title: its first line should be "# Title".`);
  }
  const body = relink(text.slice(heading.index + heading[0].length).replace(/^\s+/, ""), guides);
  const frontmatter = [
    "---",
    `title: ${yaml(heading[1].trim())}`,
    `description: ${yaml(describe(body))}`,
    `editUrl: ${yaml(`${REPOSITORY}/edit/main/docs/${file}`)}`,
    "---",
    "",
  ].join("\n");
  const name = slugOf(file) === "" ? "index.md" : `${slugOf(file)}.md`;
  await writeFile(join(TARGET, name), `${frontmatter}${body}`);
}
console.log(`Published ${files.length} guides under /docs/`);
