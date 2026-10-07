import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // fixtures/ のサンプルアプリのテストは対象にしない
    include: ["tests/**/*.test.ts"],
  },
});
