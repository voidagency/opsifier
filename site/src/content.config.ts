import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro:content";

// The /docs/ pages, written by scripts/sync-docs.mjs from the repository's docs/ folder.
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
