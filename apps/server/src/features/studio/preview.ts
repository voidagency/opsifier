import { createHash } from "node:crypto";
import type { AppDeps } from "../../core/context";
import { findService, saveServiceSpec } from "../services/repo";
import { listLinkedApps } from "./repo";

/**
 * The Dockerfile of a project's preview, made when a project is added to the Studio: the project's
 * Vite development server, run on the folder the agent works in, mounted at /app.
 *
 * - Dependencies come from the project's own lockfile, Bun's when it has one, else npm's, and
 *   neither tool writes the lockfile: the preview must never leave a change in the repository.
 * - It runs as the agent server's user, so that both can change the same files.
 * - Vite runs with the project's own config plus what the Studio needs. Every page asks the browser
 *   to load the inspector from `OPSIFIER_STUDIO_INSPECTOR_URL`, the panel's own address: the browser
 *   reaches the panel since it shows the Studio, so the preview never fetches anything, and a page
 *   always has the panel's current inspector. Every host is allowed, since the preview answers on its
 *   domains and to the agent by its service's name.
 *
 * The text is raw: what it holds is written to the image as it is. It has no `${`, which a template
 * literal would read as its own; the shell script uses `$PORT`, set by `ENV`.
 */
const TEMPLATE = String.raw`# syntax=docker/dockerfile:1
# Opsifier Studio preview. Made by the panel: the panel makes it again when the project is added again.
FROM node:22-bookworm-slim
COPY --from=oven/bun:1.3 /usr/local/bin/bun /usr/local/bin/bun
RUN mkdir -p /opt/opsifier-studio && cat > /opt/opsifier-studio/vite.config.mjs <<'EOF'
// The project's own Vite config, with what the Opsifier Studio needs in development.
import { pathToFileURL } from "node:url";

const vite = await import(pathToFileURL("/app/node_modules/vite/dist/node/index.js").href);
// The browser loads the inspector from the panel, which it reaches already: added to Vite's client,
// which every page of a development server loads, so that single-page and server-rendered apps alike
// have it. This server never fetches it.
const address = process.env.OPSIFIER_STUDIO_INSPECTOR_URL;
const loader = address
  ? "\n{ const script = document.createElement(\"script\"); script.src = " +
    JSON.stringify(address) +
    "; script.async = true; document.head.appendChild(script); }\n"
  : "";
const inspector = {
  name: "opsifier-studio-inspector",
  apply: "serve",
  transform: (code, module) =>
    loader !== "" && /vite\/dist\/client\/client\.mjs/.test(module) ? code + loader : undefined,
};

export default async (env) => {
  const loaded = await vite.loadConfigFromFile(env, undefined, "/app");
  return vite.mergeConfig(loaded?.config ?? {}, { plugins: [inspector], server: { allowedHosts: true } });
};
EOF
RUN printf '%s\n' \
      '#!/bin/sh' \
      'set -e' \
      'cd /app' \
      'if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --no-save; elif [ -f package-lock.json ]; then npm ci --no-audit --no-fund || npm install --no-save --no-package-lock --no-audit --no-fund; else bun install --no-save; fi' \
      'exec ./node_modules/.bin/vite dev --host 0.0.0.0 --port "$PORT" --config /opt/opsifier-studio/vite.config.mjs' \
      > /usr/local/bin/opsifier-studio-preview \
 && chmod 755 /usr/local/bin/opsifier-studio-preview \
 && chown -R __UID__:__GID__ /opt/opsifier-studio
ENV HOME=/tmp PORT=80
USER __UID__:__GID__
WORKDIR /app
CMD ["opsifier-studio-preview"]
`;

/** Where the panel serves the Studio's inspector, which project previews load from it. */
export const INSPECTOR_PATH = "/studio-inspector.js";

/** What a preview is told to load the inspector from, the panel's own address. */
export const inspectorEnv = (panel: string | null): string =>
  panel === null ? "" : `OPSIFIER_STUDIO_INSPECTOR_URL=${panel}${INSPECTOR_PATH}\n`;

/** The preview's Dockerfile, for the user the agent server writes the project's files as. */
export function previewDockerfile(user: { uid: number; gid: number }): string {
  return TEMPLATE.replaceAll("__UID__", String(user.uid)).replaceAll("__GID__", String(user.gid));
}

/** The line the panel writes under the syntax line of every preview's Dockerfile. */
const MADE_BY_PANEL = "# Opsifier Studio preview. Made by the panel";

/** What the current template writes for the user a Dockerfile runs as, or null without one. */
function currentFor(dockerfile: string): string | null {
  const user = /^USER (\d+):(\d+)$/m.exec(dockerfile);
  return user === null ? null : previewDockerfile({ uid: Number(user[1]), gid: Number(user[2]) });
}

/** Whether the panel wrote this Dockerfile, for a preview the Studio made. */
export const isPanelMadePreview = (dockerfile: string): boolean =>
  (dockerfile.split("\n", 2)[1] ?? "").startsWith(MADE_BY_PANEL);

/**
 * The earlier templates, as SHA-256 of their text with the user left as placeholders: 0.8.2 to
 * 0.11.0 fetched the inspector once when Vite started.
 */
const EARLIER_TEMPLATES: ReadonlySet<string> = new Set([
  "f85dc08dac75e1414f2a00b020bd14c250f720eabd7d9498987eec8dcc3fdf38",
]);

/**
 * A preview's Dockerfile as the current template would write it, for the same user. Null when it is
 * up to date already, or when it is not exactly what an earlier template wrote: someone changed it,
 * and it is theirs to change again.
 */
export function refreshedDockerfile(dockerfile: string): string | null {
  if (!isPanelMadePreview(dockerfile)) {
    return null;
  }
  const user = /^USER (\d+):(\d+)$/m.exec(dockerfile);
  if (user === null) {
    return null;
  }
  const current = previewDockerfile({ uid: Number(user[1]), gid: Number(user[2]) });
  if (current === dockerfile) {
    return null;
  }
  const asWritten = dockerfile.replaceAll(`${user[1]}:${user[2]}`, "__UID__:__GID__");
  return EARLIER_TEMPLATES.has(createHash("sha256").update(asWritten).digest("hex")) ? current : null;
}

/**
 * Brings the Dockerfile of every linked preview the panel wrote to the current template, so that
 * whatever deploys it next, the Studio's first start included, builds what this version means. What
 * runs keeps its image until then. Nothing else of a service changes.
 */
export function refreshPreviewDockerfiles(deps: Pick<AppDeps, "db" | "logger" | "now">): number {
  let refreshed = 0;
  for (const app of listLinkedApps(deps.db)) {
    const record = findService(deps.db, app.projectName, app.serviceName);
    const source = record?.spec.source;
    if (record === undefined || source?.type !== "dockerfile") {
      continue;
    }
    const dockerfile = refreshedDockerfile(source.dockerfile);
    if (
      dockerfile === null &&
      isPanelMadePreview(source.dockerfile) &&
      source.dockerfile !== currentFor(source.dockerfile)
    ) {
      deps.logger.info(
        { project: record.projectName, service: record.name },
        "A Studio preview's Dockerfile was changed by hand: it keeps it, and the template's changes",
      );
    }
    if (dockerfile !== null) {
      saveServiceSpec(
        deps.db,
        record.projectName,
        record.name,
        { ...record.spec, source: { ...source, dockerfile } },
        new Date(deps.now()),
      );
      refreshed += 1;
    }
  }
  if (refreshed > 0) {
    deps.logger.info({ refreshed }, "Brought Studio previews' Dockerfiles to the current template");
  }
  return refreshed;
}

/** The port the preview's development server listens on, in its container. */
export const PREVIEW_PORT = 80;

/** What a preview may use: a development server installs and rebuilds a whole project. */
export const PREVIEW_RESOURCES = { memoryReservation: 0, memoryLimit: 3072, cpuReservation: 0, cpuLimit: 2 };
