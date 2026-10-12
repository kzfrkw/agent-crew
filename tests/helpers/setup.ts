import { rmSync } from "node:fs";
import { afterAll } from "vitest";

// テスト(と、テストから起動する CLI)では macOS の通知を出さない(7-3)
process.env.AGENT_CREW_NOTIFY = "0";
import { createdTempDirs } from "./gitrepo.ts";

// テストが作った一時ディレクトリを、テストファイルの終わりに消す($TMPDIR に溜まらないように)
afterAll(() => {
  for (const dir of createdTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
