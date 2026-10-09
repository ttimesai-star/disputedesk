import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the API runs on :8787 (npm run dev:server). In production one Node
// process serves both, so the web app always calls a relative /api.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8787" } },
  // AG Grid Community with all modules is ~1.3 MB minified; fine for a dashboard.
  build: { chunkSizeWarningLimit: 1600 },
});
