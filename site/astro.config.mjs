import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://opsifier.com",
  trailingSlash: "always",
  build: { format: "directory", inlineStylesheets: "never" },
  // Nothing inlined: the site's Content-Security-Policy only allows its own files.
  vite: {
    build: { assetsInlineLimit: 0 },
    server: { fs: { allow: [".."] } },
  },
});
