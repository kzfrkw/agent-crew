import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * GUI のビルド(docs/design-memo.md 14章 v0.8)。結果は dist/gui/ に出し、agent-crew serve が配信する。
 * 開発時(npm run dev:gui)は /api と /files を serve(既定 4300)に中継する。
 */
const target = `http://127.0.0.1:${process.env.AGENT_CREW_PORT ?? "4300"}`;

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist/gui", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": { target, changeOrigin: true },
      "/files": { target, changeOrigin: true },
    },
  },
});
