# syntax=docker/dockerfile:1
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
 && chown -R 10001:10001 /opt/opsifier-studio
ENV HOME=/tmp PORT=80
USER 10001:10001
WORKDIR /app
CMD ["opsifier-studio-preview"]
