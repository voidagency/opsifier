import { z } from "zod";
import { resourceName } from "./common";
import { type BoxHooks, boxHooks } from "./service-tabs/box-hooks";
import { type BoxModulesConfig, boxModulesConfig } from "./service-tabs/box-modules";
import { type BoxProcess, boxProcess } from "./service-tabs/box-processes";

/** Where the only part of a box that outlives a rebuild is mounted. */
export const BOX_WORKSPACE_PATH = "/workspace";
export const BOX_WORKSPACE_VOLUME = "workspace";

/** Who everything in a box runs as, in every box: hooks at start, processes and modules alike. */
export const BOX_RUN_AS = { user: "box", uid: 1000, gid: 1000 } as const;

export const boxPresetIds = [
  "static-site",
  "node-service",
  "php-site",
  "python-service",
  "ruby-service",
] as const;
export const boxPresetId = z.enum(boxPresetIds);
export type BoxPresetId = z.infer<typeof boxPresetId>;

export interface BoxPreset {
  id: BoxPresetId;
  modules: BoxModulesConfig;
  processes: BoxProcess[];
  hooks: BoxHooks;
  /** Written only where no file of that name exists, so applying a preset never replaces any code. */
  starterFiles: Readonly<Record<string, string>>;
}

const noHooks: BoxHooks = { build: "", start: "" };

const supervised = (name: string, command: string): BoxProcess => ({
  name,
  command,
  directory: ".",
  enabled: true,
});

const SERVICE_NOTE = "Listens on PORT, which comes from the primary domain of this service.";

/** What each preset sets up. A preset is a fast start, never a template that owns a workspace. */
export const boxPresets: readonly BoxPreset[] = [
  {
    id: "static-site",
    modules: boxModulesConfig.parse({ nginx: { documentRoot: "public" } }),
    processes: [],
    hooks: noHooks,
    starterFiles: {
      "public/index.html": `<!doctype html>
<meta charset="utf-8">
<title>It works</title>
<h1>It works</h1>
<p>Edit public/index.html in this box's workspace.</p>
`,
    },
  },
  {
    id: "node-service",
    modules: boxModulesConfig.parse({ node: { version: "24" } }),
    processes: [supervised("web", "node server.js")],
    hooks: {
      build: "",
      start: "if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; fi\n",
    },
    starterFiles: {
      "server.js": `// ${SERVICE_NOTE}
const http = require("node:http");

http
  .createServer((_request, response) => {
    response.end("It works\\n");
  })
  .listen(Number(process.env.PORT ?? 80));
`,
    },
  },
  {
    id: "php-site",
    modules: boxModulesConfig.parse({
      php: { version: "8.4", extensions: ["opcache", "composer"] },
      nginx: { documentRoot: "public" },
    }),
    processes: [],
    hooks: { build: "", start: "if [ -f composer.json ]; then composer install --no-interaction; fi\n" },
    starterFiles: {
      "public/index.php": `<?php
echo "It works\\n";
`,
    },
  },
  {
    id: "python-service",
    modules: boxModulesConfig.parse({ python: { version: "3.14" } }),
    processes: [supervised("web", ".venv/bin/python app.py")],
    hooks: {
      build: "",
      start: `python3 -m venv .venv
if [ -f requirements.txt ]; then .venv/bin/pip install --requirement requirements.txt; fi
`,
    },
    starterFiles: {
      "app.py": `# ${SERVICE_NOTE}
import http.server
import os


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"It works\\n")


http.server.ThreadingHTTPServer(("", int(os.environ.get("PORT", "80"))), Handler).serve_forever()
`,
    },
  },
  {
    id: "ruby-service",
    modules: boxModulesConfig.parse({ ruby: { version: "3.4" } }),
    processes: [supervised("web", "ruby app.rb")],
    hooks: { build: "", start: "if [ -f Gemfile ]; then bundle install; fi\n" },
    starterFiles: {
      "app.rb": `# ${SERVICE_NOTE}
require "socket"

server = TCPServer.new("", Integer(ENV.fetch("PORT", "80")))
loop do
  Thread.new(server.accept) do |client|
    client.gets
    client.write("HTTP/1.1 200 OK\\r\\nContent-Length: 9\\r\\nConnection: close\\r\\n\\r\\nIt works\\n")
    client.close
  end
end
`,
    },
  },
];

export function boxPreset(id: BoxPresetId): BoxPreset {
  const preset = boxPresets.find((candidate) => candidate.id === id);
  if (preset === undefined) {
    throw new Error(`There is no preset ${id}.`);
  }
  return preset;
}

/** POST /api/v1/projects/{project}/box */
export const createBoxRequest = z.object({
  name: resourceName,
  preset: boxPresetId.nullable().default(null),
});
export type CreateBoxRequest = z.input<typeof createBoxRequest>;

/** POST .../box/preset: replaces the modules, processes and hooks, and leaves every file alone. */
export const applyBoxPresetRequest = z.object({ preset: boxPresetId });
export type ApplyBoxPresetRequest = z.input<typeof applyBoxPresetRequest>;

/** What a rebuild changes, worst first in anything that shows one. */
export const boxChangeKinds = ["security", "upgrade", "modules", "configuration"] as const;
export const boxChangeKind = z.enum(boxChangeKinds);
export type BoxChangeKind = z.infer<typeof boxChangeKind>;

export const boxChange = z.object({
  kind: boxChangeKind,
  /** A module id, `base`, or `config`. */
  subject: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type BoxChange = z.infer<typeof boxChange>;

/** Why a build happened, in one word. A build can have several changes and is filed under the first. */
export const boxBuildReasons = [
  "first",
  "security",
  "upgrade",
  "modules",
  "configuration",
  "forced",
  "unchanged",
] as const;
export const boxBuildReason = z.enum(boxBuildReasons);
export type BoxBuildReason = z.infer<typeof boxBuildReason>;

/** One line of a box's build history: the reason it was rebuilt, what moved and how it ended. */
export const boxBuildEntry = z.object({
  /** The deployment's Action. */
  actionId: z.string(),
  at: z.iso.datetime(),
  status: z.enum(["succeeded", "failed", "cancelled"]),
  reason: boxBuildReason,
  changes: z.array(boxChange),
  matrixRevision: z.string(),
  /** Docker's id of the image it produced. Null when it did not produce one. */
  imageId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  /** Why it did not finish. Null when it did. */
  error: z.string().nullable(),
});
export type BoxBuildEntry = z.infer<typeof boxBuildEntry>;

/** What a built image holds, so the next build can say what moved. */
export const boxManifest = z.object({
  matrixRevision: z.string(),
  base: z.string(),
  modules: z.record(
    z.string(),
    z.object({ version: z.string(), pin: z.string(), extensions: z.array(z.string()) }),
  ),
  /** The processes, hooks and web root, as a fingerprint: any change to them rebuilds the last layers. */
  configuration: z.string(),
});
export type BoxManifest = z.infer<typeof boxManifest>;

/** What a box does for itself, for the interface and the API to state rather than imply. */
export const boxRuntimeDescription = z.object({
  user: z.string(),
  uid: z.number().int(),
  gid: z.number().int(),
  workspacePath: z.string(),
  workspaceVolume: z.string(),
});
export type BoxRuntimeDescription = z.infer<typeof boxRuntimeDescription>;

/** GET /api/v1/projects/{project}/services/{service}/box */
export const boxDetail = z.object({
  modules: boxModulesConfig,
  processes: z.array(boxProcess),
  hooks: boxHooks,
  preset: boxPresetId.nullable(),
  matrixRevision: z.string(),
  /** What the last successful build contains, by module. Null until there is one. */
  built: boxManifest.nullable(),
  /** What a build would change: what the next deployment will report as its reason. */
  pendingChanges: z.array(boxChange),
  /** What the matrix no longer allows in this selection: a build stops here until it is fixed. */
  issues: z.array(z.object({ field: z.string(), message: z.string() })),
  history: z.array(boxBuildEntry),
  runtime: boxRuntimeDescription,
  /** The Dockerfile these settings generate, shown so nothing about the image is hidden. */
  dockerfile: z.string(),
});
export type BoxDetail = z.infer<typeof boxDetail>;
