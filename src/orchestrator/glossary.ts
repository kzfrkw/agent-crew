import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectDir } from "./paths.ts";

/**
 * プロジェクトの用語集(v0.24)。解説担当が新しく説明した用語を、ツールが足していく。
 * 次の解説では用語集を渡し、同じ用語の説明を繰り返さない(読み手が少しずつ慣れていく前提)
 */

export function glossaryPath(home: string, projectId: number): string {
  return join(projectDir(home, projectId), "glossary.md");
}

const TERM = /^- \*\*(.+?)\*\*/;
const norm = (s: string) => s.trim().toLowerCase();

/** 用語を足す(すでにある用語は足さない)。足した数を返す */
export function appendGlossary(path: string, terms: { term: string; explanation: string }[], source: string): number {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const known = new Set(existing.split("\n").flatMap((l) => (TERM.exec(l) ? [norm(TERM.exec(l)![1]!)] : [])));
  const fresh = terms.filter((t) => t.term.trim() && t.explanation.trim() && !known.has(norm(t.term)) && (known.add(norm(t.term)), true));
  if (!fresh.length) return 0;
  mkdirSync(dirname(path), { recursive: true });
  const lines = fresh.map((t) => `- **${t.term.trim()}**: ${t.explanation.trim().replace(/\s+/g, " ")}(${source})`);
  appendFileSync(path, `${existing ? "" : "# 用語集\n\n解説担当が説明した用語。次の解説では、ここにある用語の説明を繰り返さない\n\n"}${lines.join("\n")}\n`);
  return fresh.length;
}
