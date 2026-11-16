import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const REPOSITORY = "https://github.com/voidagency/opsifier";

export default defineConfig({
  site: "https://opsifier.com",
  trailingSlash: "always",
  build: { format: "directory", inlineStylesheets: "never" },
  // Nothing inlined: the site's Content-Security-Policy only allows its own files.
  vite: {
    build: { assetsInlineLimit: 0 },
    server: { fs: { allow: [".."] } },
  },
  // Each page carries the hashes of the few inline scripts it needs, and search runs WebAssembly from
  // the site itself. Inline style attributes colour the code blocks.
  security: {
    csp: {
      scriptDirective: { resources: ["'self'", "'wasm-unsafe-eval'"] },
      styleDirective: { resources: ["'self'", { resource: "'unsafe-inline'", kind: "attribute" }] },
    },
  },
  integrations: [
    starlight({
      title: "Opsifier",
      description:
        "How to install Opsifier, an open-source control panel for your own server, and deploy apps, databases and domains with it.",
      logo: { src: "./src/assets/opsifier-mark.svg", alt: "Opsifier" },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: REPOSITORY }],
      editLink: { baseUrl: `${REPOSITORY}/edit/main/docs/` },
      // The site's own not-found page answers for every address, the documentation's included.
      disable404Route: true,
      customCss: [
        "@fontsource/poppins/latin-400.css",
        "@fontsource/poppins/latin-500.css",
        "@fontsource/poppins/latin-600.css",
        "@fontsource/ibm-plex-mono/latin-400.css",
        "./src/styles/docs.css",
      ],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Overview", slug: "docs" },
            { label: "Install on a server", slug: "docs/install" },
            { label: "Deploy your first app", slug: "docs/first-app" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Databases", slug: "docs/databases" },
            { label: "Domains and HTTPS", slug: "docs/domains" },
            { label: "Backups", slug: "docs/backups" },
            { label: "Builders", slug: "docs/builders" },
            { label: "Studio", slug: "docs/studio" },
          ],
        },
        {
          label: "Tools",
          items: [
            { label: "Command line", slug: "docs/cli" },
            { label: "MCP server", slug: "docs/mcp" },
            { label: "API", slug: "docs/api" },
          ],
        },
        {
          label: "Reference",
          items: [{ label: "Architecture", slug: "docs/architecture" }],
        },
      ],
    }),
  ],
});
