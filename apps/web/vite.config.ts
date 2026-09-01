import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "../dist/client",
  },
  plugins: [react()],
  root: "client",
  server: {
    // Local dev: SPA on vite, API on `wrangler dev` (port 8787).
    proxy: { "/api": "http://localhost:8787" },
  },
});
