import type { Rubric } from "../roles/rubrics.ts";

/**
 * ルーブリックの項目ごとの結果と判定の一致(設計メモ v0.22)。DB やプロセスに触れない純粋関数。
 * Must の有無と判定の一致を見るレビューの検査(review-findings.ts)と同じ考え方で、判定の言い回しではなく項目の結果で決める:
 * - すべての項目に、1回ずつ、根拠つきで答えている。ルーブリックに無い項目を答えていない
 * - approve は must の不合格が無いときだけ。changes_requested は must の不合格があるときだけ
 * - need_human は項目の結果を問わない(人の判断が要る論点は項目の外にある)
 */

export type RubricResult = { id: string; result: "pass" | "fail"; evidence: string };
export type RubricCheck = { ok: true; mustFailed: string[]; shouldFailed: string[] } | { ok: false; reason: string };

export function checkRubric(verdict: string, rubric: Rubric, results: RubricResult[]): RubricCheck {
  const bad = (reason: string): RubricCheck => ({ ok: false, reason: `ルーブリック ${rubric.name}: ${reason}` });
  const known = new Set(rubric.items.map((i) => i.id));
  const seen = new Set<string>();
  for (const r of results) {
    if (!known.has(r.id)) return bad(`ルーブリックに無い項目 ${r.id} に答えています`);
    if (seen.has(r.id)) return bad(`項目 ${r.id} に2回答えています`);
    if (!r.evidence.trim()) return bad(`項目 ${r.id} の根拠(成果物のどこか)がありません`);
    seen.add(r.id);
  }
  const unanswered = rubric.items.filter((i) => !seen.has(i.id)).map((i) => i.id);
  if (unanswered.length) return bad(`項目 ${unanswered.join(", ")} に答えていません`);

  const failed = new Set(results.filter((r) => r.result === "fail").map((r) => r.id));
  const mustFailed = rubric.items.filter((i) => i.severity === "must" && failed.has(i.id)).map((i) => i.id);
  const shouldFailed = rubric.items.filter((i) => i.severity === "should" && failed.has(i.id)).map((i) => i.id);
  if (verdict === "approve" && mustFailed.length) return bad(`approve ですが、must の項目 ${mustFailed.join(", ")} が不合格です。must の不合格があるなら changes_requested です`);
  if (verdict === "changes_requested" && !mustFailed.length) return bad("changes_requested ですが、不合格の must の項目がありません。should だけなら approve にして記録に残します");
  return { ok: true, mustFailed, shouldFailed };
}
