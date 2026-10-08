import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_GUI_DIR } from "./static.ts";

/**
 * GUI のビルドが最新かを調べ、必要ならビルドする(設計メモ14章 v0.8)。
 * git pull の後に npm install を忘れても、serve を起動すれば新しい GUI になるようにする。
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** GUI のビルドに効くもの(gui/ と、GUI が取り込む共有の型・定数、依存の版) */
const DEFAULT_SOURCES = [
  join(ROOT, "gui"),
  join(ROOT, "src", "server", "api-types.ts"),
  join(ROOT, "src", "orchestrator", "states.ts"),
  join(ROOT, "package-lock.json"),
];

export type GuiBuildState = "ok" | "missing" | "stale";

function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let max = 0;
  for (const name of readdirSync(path)) {
    if (name === "node_modules" || name.startsWith(".") || /\.test\.tsx?$/.test(name)) continue;
    max = Math.max(max, newestMtime(join(path, name)));
  }
  return max;
}

export function guiBuildState(o: { sources?: string[]; outDir?: string } = {}): GuiBuildState {
  const index = join(o.outDir ?? DEFAULT_GUI_DIR, "index.html");
  if (!existsSync(index)) return "missing";
  const newest = Math.max(...(o.sources ?? DEFAULT_SOURCES).map(newestMtime));
  return newest > statSync(index).mtimeMs ? "stale" : "ok";
}

/** npm run build:gui を実行する。出力はそのまま端末に流す */
export function buildGui(): boolean {
  const r = spawnSync("npm", ["run", "-s", "build:gui"], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
  return r.status === 0;
}
