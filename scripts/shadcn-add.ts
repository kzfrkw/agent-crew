/**
 * shadcn/ui の部品を公式レジストリから取得して gui/src/components/ui/ に置く(設計メモ v0.11)。
 *   node scripts/shadcn-add.ts button badge ...
 * shadcn の CLI はルートに GUI の package.json と tsconfig がある構成を前提にするため、
 * GUI を gui/ に分けているこのリポジトリでは、CLI と同じ書き換え(import の別名)だけをここで行う。
 * 取得した部品は、docs/surface.md の原則に合わせて手で直してよい(上書きしないよう、既存のファイルは飛ばす)。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const REGISTRY = "https://ui.shadcn.com/r/styles/new-york-v4";
const root = new URL("..", import.meta.url).pathname;
const outDir = join(root, "gui/src/components/ui");
const force = process.argv.includes("--force");
const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (names.length === 0) throw new Error("部品の名前を指定してください(例: button badge)");

type Item = { name: string; dependencies?: string[]; registryDependencies?: string[]; files: { path: string; content: string }[] };

/** CLI と同じく、レジストリの仮の import を、このリポジトリの別名(@/ = gui/src)に書き換える */
function rewrite(src: string): string {
  return src
    .replace(/from "cn"/g, 'from "@/lib/utils"')
    .replace(/@\/registry\/new-york-v4\/ui\//g, "@/components/ui/")
    .replace(/@\/registry\/new-york-v4\/lib\//g, "@/lib/")
    .replace(/@\/registry\/new-york-v4\/hooks\//g, "@/hooks/");
}

const deps = new Set<string>();
const seen = new Set<string>();
async function add(name: string): Promise<void> {
  if (seen.has(name)) return;
  seen.add(name);
  const res = await fetch(`${REGISTRY}/${name}.json`);
  if (!res.ok) throw new Error(`${name} を取得できません(${res.status})`);
  const item = (await res.json()) as Item;
  for (const d of item.dependencies ?? []) if (d !== "cn") deps.add(d);
  for (const f of item.files) {
    if (!f.path.includes("/ui/")) continue;
    const target = join(outDir, basename(f.path));
    if (existsSync(target) && !force) {
      console.log(`飛ばしました(既にあります): ${basename(f.path)}`);
      continue;
    }
    mkdirSync(outDir, { recursive: true });
    writeFileSync(target, rewrite(f.content));
    console.log(`追加しました: gui/src/components/ui/${basename(f.path)}`);
  }
  for (const r of item.registryDependencies ?? []) if (!r.startsWith("http") && r !== "utils") await add(r);
}

for (const n of names) await add(n);
if (deps.size) console.log(`必要な依存: ${[...deps].join(" ")}`);
