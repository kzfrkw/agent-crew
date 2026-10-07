import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { addApproval, listTaskRepos } from "../db/store.ts";
import { headSha } from "../git/worktree.ts";
import type { AppContext } from "./context.ts";
import { applyEvent } from "./engine.ts";
import { taskDir } from "./paths.ts";

/** 人のコメント・回答。次に起動する役割の入力になる */
export function humanNotesPath(home: string, taskId: number): string {
  return join(taskDir(home, taskId), "human-notes.md");
}

export function appendHumanNote(ctx: AppContext, taskId: number, heading: string, text: string): void {
  mkdirSync(taskDir(ctx.home, taskId), { recursive: true });
  appendFileSync(humanNotesPath(ctx.home, taskId), `\n## ${new Date().toISOString()} ${heading}\n\n${text.trim()}\n`);
}

export function approveTask(ctx: AppContext, taskId: number, kind: "plan" | "final", comment?: string): void {
  applyEvent(ctx, taskId, { type: "approve", kind });
  if (kind === "final") {
    // 最終確認の承認は、承認した時点のコミットに紐づける
    for (const tr of listTaskRepos(ctx.db, taskId)) {
      addApproval(ctx.db, { taskId, repoId: tr.repoId, kind, result: "approved", commitSha: headSha(tr.worktreePath, ctx.gitEnv), comment });
    }
  } else {
    addApproval(ctx.db, { taskId, kind, result: "approved", comment });
  }
  if (comment) appendHumanNote(ctx, taskId, `${kind === "plan" ? "計画" : "最終確認"}の承認コメント`, comment);
}

export function rejectTask(ctx: AppContext, taskId: number, kind: "plan" | "final", comment: string): void {
  if (!comment.trim()) throw new Error("却下の理由(コメント)を書いてください");
  applyEvent(ctx, taskId, { type: "reject", kind });
  addApproval(ctx.db, { taskId, kind, result: "rejected", comment });
  appendHumanNote(ctx, taskId, `${kind === "plan" ? "計画" : "最終確認"}の却下`, comment);
}

export function answerTask(ctx: AppContext, taskId: number, message: string): void {
  if (!message.trim()) throw new Error("回答を書いてください");
  applyEvent(ctx, taskId, { type: "answer" });
  appendHumanNote(ctx, taskId, "人からの回答", message);
}

export function cancelTask(ctx: AppContext, taskId: number): void {
  applyEvent(ctx, taskId, { type: "cancel" });
}
