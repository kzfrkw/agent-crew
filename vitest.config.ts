import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // fixtures/ のサンプルアプリのテストは対象にしない
    include: ["tests/**/*.test.ts"],
    // 一時的な git リポジトリを多く作るため、並行実行時は 5 秒を超えることがある
    testTimeout: 30_000,
  },
});
