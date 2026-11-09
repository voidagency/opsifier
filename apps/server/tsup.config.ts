import { defineConfig } from "tsup";

/** CommonJS bundled into an ES module still expects these, which only CommonJS provides by itself. */
const COMMONJS_GLOBALS = [
  'import { createRequire as __createRequire } from "node:module";',
  'import { dirname as __pathDirname } from "node:path";',
  'import { fileURLToPath as __fileUrlToPath } from "node:url";',
  "const require = __createRequire(import.meta.url);",
  "const __filename = __fileUrlToPath(import.meta.url);",
  "const __dirname = __pathDirname(__filename);",
].join(" ");

export default defineConfig({
  // One file, so the image needs no node_modules beyond the native SQLite binding. ssh2's optional
  // native helpers are left out too: it works without them, and falls back when they aren't there.
  noExternal: [/^(?!better-sqlite3$|cpu-features$)(?!.*\.node$).*/],
  external: ["better-sqlite3", "cpu-features", /\.node$/],
  banner: { js: COMMONJS_GLOBALS },
});
