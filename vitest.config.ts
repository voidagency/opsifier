import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.test.{ts,tsx}", "packages/**/*.test.ts", "infra/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
