/**
 * The Dockerfile of a project's preview, made when a project is added to the Studio: the project's
 * Vite development server, run on the folder the agent works in, mounted at /app.
 *
 * - Dependencies come from the project's own lockfile, Bun's when it has one, else npm's, and
 *   neither tool writes the lockfile: the preview must never leave a change in the repository.
 * - It runs as the agent server's user, so that both can change the same files.
 * - Vite runs with the project's own config plus what the Studio needs. The inspector is fetched
 *   once from `OPSIFIER_STUDIO_INSPECTOR_URL` when the server starts, and comes with Vite's client
 *   in every page. Every host is allowed, since the preview answers on its domains and to the agent
 *   by its service's name.
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
const address = process.env.OPSIFIER_STUDIO_INSPECTOR_URL;
let source = "";
if (address) {
  try {
    const answer = await fetch(address, { signal: AbortSignal.timeout(10000) });
    if (answer.ok) {
      source = await answer.text();
    } else {
      console.warn("[opsifier-studio] the inspector at " + address + " answered " + answer.status);
    }
  } catch (error) {
    console.warn("[opsifier-studio] the inspector at " + address + " could not be fetched: " + error);
  }
}

// The import is named, so that Vite's import analysis resolves it through this plugin; the browser
// then asks for /@id/__x00__opsifier-studio-inspector, which comes back here as the id.
const name = "virtual:opsifier-studio-inspector";
const id = "\0opsifier-studio-inspector";
const inspector = {
  name: "opsifier-studio-inspector",
  apply: "serve",
  resolveId: (module) => (module === name || module === id ? id : undefined),
  load: (module) => (module === id ? source : undefined),
  transform: (code, module) =>
    source !== "" && /vite\/dist\/client\/client\.mjs/.test(module)
      ? code + "\nimport(" + JSON.stringify(name) + ");\n"
      : undefined,
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

/** The preview's Dockerfile, for the user the agent server writes the project's files as. */
export function previewDockerfile(user: { uid: number; gid: number }): string {
  return TEMPLATE.replaceAll("__UID__", String(user.uid)).replaceAll("__GID__", String(user.gid));
}

/** The port the preview's development server listens on, in its container. */
export const PREVIEW_PORT = 80;

/** What a preview may use: a development server installs and rebuilds a whole project. */
export const PREVIEW_RESOURCES = { memoryReservation: 0, memoryLimit: 3072, cpuReservation: 0, cpuLimit: 2 };
