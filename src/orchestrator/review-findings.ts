import type { z } from "zod";
import type { FindingSchema, Judgment } from "../roles/schemas.ts";

/**
 * レビューの指摘と監査結果の扱い(設計メモの4章)。DBやプロセスに触れない純粋関数。
 * 指摘の重さ(Must があるか)と、監査で却下されたか、は状態遷移の判断材料なので、LLM の言い回しではなくここで決める。
 */

export type Finding = z.infer<typeof FindingSchema>;

/** Must の指摘の位置(findings 全体の中での添字) */
export function mustIndexes(findings: Finding[]): number[] {
  return findings.flatMap((f, i) => (f.severity === "must" ? [i] : []));
}

/**
 * レビュワーの判定と指摘が食い違っていないか。食い違っていれば理由を返す(推測で進めず、人に確認する)。
 * - approve は Must が無いときだけ。Should / Nit は approve と両立する(指摘として残す)
 * - changes_requested は Must があるときだけ。Should / Nit だけなら approve にする
 */
export function checkReviewConsistency(verdict: string, findings: Finding[]): string | null {
  const musts = mustIndexes(findings).length;
  if (verdict === "approve" && musts > 0) return `レビュワーが approve を返しましたが、Must の指摘が ${musts} 件あります。Must があるなら changes_requested です`;
  if (verdict === "changes_requested" && musts === 0) return "レビュワーが changes_requested を返しましたが、Must の指摘がありません。Should / Nit だけなら approve にして指摘として残します";
  return null;
}

/**
 * 監査の判定を Must 指摘に反映する。却下できるのは、invalid と明示された Must だけ(判定が無い・unverifiable は残す)。
 * 同じ指摘に判定が複数あるときは、全部が invalid のときだけ却下する。Must ではない指摘や範囲外の番号への判定は無視する。
 */
export function applyAudit(findings: Finding[], judgments: Judgment[]): { standing: number[]; dismissed: number[] } {
  const standing: number[] = [];
  const dismissed: number[] = [];
  for (const i of mustIndexes(findings)) {
    const mine = judgments.filter((j) => j.finding === i);
    (mine.length > 0 && mine.every((j) => j.result === "invalid") ? dismissed : standing).push(i);
  }
  return { standing, dismissed };
}
