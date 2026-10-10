import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { addApproval, getTask, listTaskRepos } from "../db/store.ts";
import { headSha } from "../git/worktree.ts";
import type { AppContext } from "./context.ts";
import { applyEvent, ensureWorktrees } from "./engine.ts";
import type { DesignPlan } from "./transitions.ts";
import { taskDir } from "./paths.ts";

/** 人のコメント・回答。次に起動する役割の入力になる */
export function humanNotesPath(home: string, taskId: number): string {
  return join(taskDir(home, taskId), "human-notes.md");
}

export function appendHumanNote(ctx: AppContext, taskId: number, heading: string, text: string): void {
  mkdirSync(taskDir(ctx.home, taskId), { recursive: true });
  appendFileSync(humanNotesPath(ctx.home, taskId), `\n## ${new Date().toISOString()} ${heading}\n\n${text.trim()}\n`);
}

/** design は計画の承認のときだけ使う(設計の段で動かす役割の、人による上書き) */
export function approveTask(ctx: AppContext, taskId: number, kind: "plan" | "design" | "final", comment?: string, design?: DesignPlan): void {
  const task = getTask(ctx.db, taskId);
  if (!task) throw new Error(`タスク ${taskId} がありません`);
  if (kind === "plan" && task.repos && task.state === "awaiting_plan_approval") {
    // 複数リポジトリ: 2つ以上を変えるなら設計者は必須(人も外せない)。選ばれたリポジトリだけ worktree を作る(設計メモ v0.14)
    if (task.repos.length > 1) design = { ...(design ?? task.design), architect: true };
    ensureWorktrees(ctx, task, task.repos);
  }
  applyEvent(ctx, taskId, { type: "approve", kind, ...(kind === "plan" && design ? { design } : {}) });
  if (kind === "final") {
    // 最終確認の承認は、承認した時点のコミットに紐づける
    for (const tr of listTaskRepos(ctx.db, taskId)) {
      addApproval(ctx.db, { taskId, repoId: tr.repoId, kind, result: "approved", commitSha: headSha(tr.worktreePath, ctx.gitEnv), comment });
    }
  } else {
    addApproval(ctx.db, { taskId, kind, result: "approved", comment });
  }
  if (comment) appendHumanNote(ctx, taskId, `${KIND_LABEL[kind]}の承認コメント`, comment);
}

const KIND_LABEL = { plan: "計画", design: "デザイン仕様", final: "最終確認" };

export function rejectTask(ctx: AppContext, taskId: number, kind: "plan" | "design" | "final", comment: string): void {
  if (!comment.trim()) throw new Error("却下の理由(コメント)を書いてください");
  applyEvent(ctx, taskId, { type: "reject", kind });
  addApproval(ctx.db, { taskId, kind, result: "rejected", comment });
  appendHumanNote(ctx, taskId, `${KIND_LABEL[kind]}の却下`, comment);
}

export function answerTask(ctx: AppContext, taskId: number, message: string): void {
  if (!message.trim()) throw new Error("回答を書いてください");
  applyEvent(ctx, taskId, { type: "answer" });
  appendHumanNote(ctx, taskId, "人からの回答", message);
}

export function cancelTask(ctx: AppContext, taskId: number): void {
  applyEvent(ctx, taskId, { type: "cancel" });
}
