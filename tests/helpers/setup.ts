import { rmSync } from "node:fs";
import { afterAll } from "vitest";
import { createdTempDirs } from "./gitrepo.ts";

// テストが作った一時ディレクトリを、テストファイルの終わりに消す($TMPDIR に溜まらないように)
afterAll(() => {
  for (const dir of createdTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
