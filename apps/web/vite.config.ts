import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.OPSIFIER_API_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // The Host header is passed through unchanged so the API's Origin check sees the page's own host.
      "/api": { target: api, changeOrigin: false, ws: true },
    },
  },
});
