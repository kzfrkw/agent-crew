import { addEvent, getProject, getProjectSettings, getRepoProtect, getTask, listEvents, listRepos } from "../db/store.ts";
import type { AppContext } from "./context.ts";

/**
 * 小さなタスクの計画の自動承認(設計メモ v0.18、8-1)。プロジェクトでオンにしたときだけ。
 * 条件は機械的に確かめられるものだけにする(プランナーの規模の判断も、ファイル数・設計の段・読ませないパスと重ねて確かめる)
 */

const MAX_FILES = 3;

/** 自動承認できない理由(空なら自動承認できる) */
export function autoApproveBlockers(ctx: AppContext, taskId: number): string[] {
  const task = getTask(ctx.db, taskId)!;
  const project = getProject(ctx.db, task.projectId)!;
  const plan = (listEvents(ctx.db, taskId, 2000).filter((e) => e.kind === "plan").at(-1)?.payload ?? {}) as { size?: string; expectedFiles?: string[]; testFirstException?: boolean };
  const repos = listRepos(ctx.db, task.projectId);
  const files = (plan.expectedFiles ?? []).map((f) => f.replace(/^\.\//, ""));
  const protect = repos.flatMap((r) => getRepoProtect(ctx.db, r.id));
  const blockers: string[] = [];
  if (plan.size !== "small") blockers.push(`規模が small ではない(${plan.size ?? "不明"})`);
  if (files.length === 0) blockers.push("変更の見込みのファイルが無い");
  if (files.length > MAX_FILES) blockers.push(`変更の見込みが ${files.length} ファイル(${MAX_FILES} まで)`);
  if (task.design?.architect || task.design?.designer) blockers.push("設計者かデザイナーを動かす");
  if (plan.testFirstException) blockers.push("テスト先行の例外");
  if (repos.length > 1) blockers.push("複数リポジトリのプロジェクト");
  if (project.testInfra !== "present") blockers.push("テスト基盤が present ではない");
  if (task.kind !== "normal") blockers.push("通常のタスクではない(テスト基盤整備など)");
  const touched = files.filter((f) => protect.some((p) => f === p || f.startsWith(`${p}/`)));
  if (touched.length) blockers.push(`読ませないパスに触れる(${touched.join("、")})`);
  return blockers;
}

/** 計画の承認を自動で行うか。オンでなければ undefined(従来どおり)。行わないなら理由を記録する */
export function decideAutoApprove(ctx: AppContext, taskId: number): boolean | undefined {
  const task = getTask(ctx.db, taskId)!;
  if (!getProjectSettings(ctx.db, task.projectId).autoApprovePlan) return undefined;
  const blockers = autoApproveBlockers(ctx, taskId);
  if (blockers.length) {
    addEvent(ctx.db, { taskId, kind: "auto_approve_skipped", payload: { reasons: blockers } });
    return false;
  }
  addEvent(ctx.db, { taskId, kind: "auto_approved", payload: { kind: "plan" } });
  return true;
}
