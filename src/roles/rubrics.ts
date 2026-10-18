import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * ルーブリック(rubrics/*.md。設計メモ v0.22、フェーズ10-1b)。判定する役割が、項目ごとに合否と根拠を返すための基準。
 * 人が書いて直す。コーディネーターや判定する役割は書き換えない(書き込めない場所に置く)
 */

export type RubricItem = { id: string; severity: "must" | "should"; text: string };
export type Rubric = { name: string; description: string; items: RubricItem[] };

/** 1ファイルの項目の上限(多すぎると守られない) */
export const MAX_RUBRIC_ITEMS = 10;

const FrontmatterSchema = z.object({ name: z.string().min(1), description: z.string().default("") });
const ITEM = /^- \[(must|should)\] ([A-Z]+\d+):\s*(.+)$/;

export function defaultRubricsDir(): string {
  return new URL("../../rubrics/", import.meta.url).pathname;
}

/** 段ごとのルーブリックの場所(役割の入力に書く) */
export function rubricPath(name: string, dir: string = defaultRubricsDir()): string {
  return join(dir, `${name}.md`);
}

export function loadRubrics(dir: string = defaultRubricsDir()): Map<string, Rubric> {
  const out = new Map<string, Rubric>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    if (!m) throw new Error(`${file}: 先頭に frontmatter(--- で囲んだ YAML)がありません`);
    const fm = FrontmatterSchema.safeParse(parseYaml(m[1]!));
    if (!fm.success) throw new Error(`${file}: frontmatter が不正です: ${fm.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    if (fm.data.name !== basename(file, ".md")) throw new Error(`${file}: name(${fm.data.name})とファイル名が一致しません`);
    const items: RubricItem[] = [];
    for (const line of m[2]!.split("\n")) {
      const im = ITEM.exec(line.trim());
      if (!im) continue;
      if (items.some((i) => i.id === im[2])) throw new Error(`${file}: 項目の ID ${im[2]} が重複しています`);
      items.push({ id: im[2]!, severity: im[1] as RubricItem["severity"], text: im[3]!.trim() });
    }
    if (!items.some((i) => i.severity === "must")) throw new Error(`${file}: must の項目が1つもありません`);
    if (items.length > MAX_RUBRIC_ITEMS) throw new Error(`${file}: 項目が ${items.length} 個あります(${MAX_RUBRIC_ITEMS} 個以内にしてください)`);
    out.set(fm.data.name, { name: fm.data.name, description: fm.data.description, items });
  }
  return out;
}
