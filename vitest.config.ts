import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    // fixtures/ のサンプルアプリのテストは対象にしない。GUI のテストは gui/src に置く(jsdom で動かす)
    include: ["tests/**/*.test.ts", "gui/src/**/*.test.{ts,tsx}"],
    // 一時的な git リポジトリを多く作るため、並行実行時は 5 秒を超えることがある
    testTimeout: 30_000,
  },
});
