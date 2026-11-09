import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type TemplateDocument, templateDocument } from "@opsifier/contract";
import type { Logger } from "pino";

/** The catalogue directory, from the source tree or next to a built bundle. Null if neither has one. */
export function findTemplatesDir(startDir: string = import.meta.dirname): string | null {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, "templates");
    if (existsSync(candidate) && readdirSync(candidate).some((name) => name.endsWith(".json"))) {
      return candidate;
    }
    dir = dirname(dir);
  }
  return null;
}

export interface CatalogueProblem {
  file: string;
  message: string;
}

export interface LoadedCatalogue {
  templates: TemplateDocument[];
  problems: CatalogueProblem[];
}

/** Reads every template in a directory. A file that fails validation is reported and left out. */
export function loadCatalogue(directory: string): LoadedCatalogue {
  const templates: TemplateDocument[] = [];
  const problems: CatalogueProblem[] = [];
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    try {
      const parsed = templateDocument.safeParse(JSON.parse(readFileSync(join(directory, file), "utf8")));
      if (!parsed.success) {
        const [issue] = parsed.error.issues;
        problems.push({ file, message: `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}` });
      } else if (parsed.data.id !== file.replace(/\.json$/, "")) {
        problems.push({ file, message: `The file must be named ${parsed.data.id}.json` });
      } else {
        templates.push(parsed.data);
      }
    } catch (error) {
      problems.push({ file, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { templates, problems };
}

let cached: readonly TemplateDocument[] | undefined;

/** The shipped catalogue, read once at the first use. */
export function catalogueTemplates(logger: Pick<Logger, "warn">): readonly TemplateDocument[] {
  if (cached !== undefined) {
    return cached;
  }
  const directory = findTemplatesDir();
  if (directory === null) {
    logger.warn("No templates directory was found: the catalogue is empty");
    cached = [];
    return cached;
  }
  const loaded = loadCatalogue(directory);
  for (const problem of loaded.problems) {
    logger.warn(problem, "A template in the catalogue is invalid and was left out");
  }
  cached = loaded.templates;
  return cached;
}
