import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build, defineConfig, type Plugin } from "vite";

const api = process.env.OPSIFIER_API_URL ?? "http://127.0.0.1:3000";

/** What takes a remark's screenshot, served by the panel next to the Studio's inspector. */
const SNAPSHOT = "studio-snapshot.js";
const snapshotEntry = fileURLToPath(new URL("./src/studio-snapshot/main.ts", import.meta.url));

/** Builds it as one script of its own, which a preview's page runs as it is, apart from the panel's app. */
async function bundleSnapshot(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "warn",
    build: {
      write: false,
      minify: true,
      lib: {
        entry: snapshotEntry,
        formats: ["iife"],
        name: "OpsifierStudioSnapshot",
        fileName: () => SNAPSHOT,
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((one) =>
    "output" in one ? one.output : [],
  );
  const chunk = outputs.find((one) => one.type === "chunk");
  if (chunk === undefined || chunk.type !== "chunk") {
    throw new Error(`${SNAPSHOT} was not built.`);
  }
  return chunk.code;
}

function studioSnapshot(): Plugin {
  let served: Promise<string> | null = null;
  return {
    name: "opsifier-studio-snapshot",
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: SNAPSHOT, source: await bundleSnapshot() });
    },
    configureServer(server) {
      server.middlewares.use(`/${SNAPSHOT}`, (_request, response, next) => {
        served ??= bundleSnapshot();
        served.then((code) => {
          response.setHeader("Content-Type", "text/javascript");
          response.end(code);
        }, next);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), studioSnapshot()],
  server: {
    proxy: {
      // The Host header is passed through unchanged so the API's Origin check sees the page's own host.
      "/api": { target: api, changeOrigin: false, ws: true },
    },
  },
});
