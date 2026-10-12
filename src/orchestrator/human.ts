import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { addApproval, createTask, getTask, listEvents, listRepos, listTaskRepos } from "../db/store.ts";
import { releaseTaskWorktrees } from "./cleanup-worktrees.ts";
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
/** プランナーが返した分割の案(8-2) */
export function splitProposal(ctx: AppContext, taskId: number): { title: string; body: string }[] {
  const plan = listEvents(ctx.db, taskId, 2000).filter((e) => e.kind === "plan").at(-1)?.payload as { split?: { title: string; body: string }[] } | undefined;
  return (plan?.split ?? []).filter((s) => s.title?.trim());
}

/**
 * 計画を分割して承認する(8-2): 子タスクを作り、親は分割済みにする。1リポジトリのプロジェクトだけ。
 * 親の worktree は使わないので片付ける(子がそれぞれ worktree を作る)
 */
function approveSplit(ctx: AppContext, taskId: number, comment?: string): void {
  const task = getTask(ctx.db, taskId)!;
  const items = splitProposal(ctx, taskId);
  if (items.length < 2) throw new Error("分割の案がありません(プランナーが2つ以上の子タスクを提案したときだけ分割できます)");
  if (listRepos(ctx.db, task.projectId).length > 1) throw new Error("複数リポジトリのプロジェクトのタスクは分割できません");
  applyEvent(ctx, taskId, { type: "split" });
  addApproval(ctx.db, { taskId, kind: "plan", result: "approved", comment: comment ?? "分割して進める" });
  items.forEach((s, i) =>
    createTask(ctx.db, {
      projectId: task.projectId,
      title: s.title,
      body: `${s.body.trim()}\n\n---\n親タスク #${task.id}「${task.title}」を分割した ${i + 1}/${items.length} 番目です。親の計画: ${join(taskDir(ctx.home, task.id), "plan.md")}${i > 0 ? "\n前の子タスクのブランチをベースに作業します。" : ""}`,
      sourceKind: task.sourceKind,
      sourceUrl: task.sourceUrl ?? undefined,
      parentId: task.id,
      seq: i + 1,
    }),
  );
  releaseTaskWorktrees(ctx, taskId);
  if (comment) appendHumanNote(ctx, taskId, "計画の承認コメント(分割)", comment);
}

export function approveTask(ctx: AppContext, taskId: number, kind: "plan" | "design" | "final", comment?: string, design?: DesignPlan, o: { split?: boolean } = {}): void {
  const task = getTask(ctx.db, taskId);
  if (!task) throw new Error(`タスク ${taskId} がありません`);
  if (o.split) {
    if (kind !== "plan") throw new Error("分割できるのは計画の承認だけです");
    approveSplit(ctx, taskId, comment);
    return;
  }
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
