import { defineConfig } from "tsup";

export default defineConfig({
  // The contract is TypeScript source inside the workspace: it has to end up in the bundle.
  noExternal: ["@opsifier/contract"],
});
