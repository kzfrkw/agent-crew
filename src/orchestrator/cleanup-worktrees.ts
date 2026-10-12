import { existsSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { addEvent, getRepo, listTaskRepos, listTasks } from "../db/store.ts";
import { isDirty, removeWorktree } from "../git/worktree.ts";
import type { AppContext } from "./context.ts";

/**
 * 終わったタスクの worktree の片付け(設計メモ v0.17、7-2)。
 * 完了・取り消しになったタスクの worktree を消す(1つ数百MBになるため)。ブランチは残す(push はリポジトリの本体から行える)。
 * 未コミットの変更がある worktree は消さずに警告する(人の作業を消さない)。
 */

const TMP_MAX_AGE_MS = 86_400_000;

export function releaseTaskWorktrees(ctx: AppContext, taskId: number): { removed: string[]; kept: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const tr of listTaskRepos(ctx.db, taskId)) {
    if (!existsSync(tr.worktreePath)) continue;
    const repo = getRepo(ctx.db, tr.repoId);
    try {
      if (isDirty(tr.worktreePath, ctx.gitEnv)) {
        kept.push(tr.worktreePath);
        addEvent(ctx.db, { taskId, kind: "warning", payload: { message: `未コミットの変更があるため worktree を残しました: ${tr.worktreePath}(片付けるときは変更をコミットするか捨ててから消してください)` } });
        continue;
      }
      // 状態はきれい。.gitignore の対象(node_modules など)が残っていても消す
      removeWorktree({ repoPath: repo!.path, worktreePath: tr.worktreePath, env: ctx.gitEnv, force: true });
      removed.push(tr.worktreePath);
    } catch (e) {
      kept.push(tr.worktreePath);
      addEvent(ctx.db, { taskId, kind: "warning", payload: { message: `worktree を消せませんでした: ${tr.worktreePath}(${(e as Error).message.split("\n")[0]})` } });
    }
  }
  if (removed.length > 0) addEvent(ctx.db, { taskId, kind: "worktree_removed", payload: { paths: removed } });
  return { removed, kept };
}

/**
 * 起動時の片付け: すでに終わったタスクの worktree、プロジェクト把握担当の調査用 worktree の空の跡、
 * ツールの一時ディレクトリのうち1日より古いもの(使用中かもしれない新しいものは残す)
 */
export function sweepFinishedWorktrees(ctx: AppContext, now = Date.now()): { removed: string[] } {
  const removed: string[] = [];
  for (const t of listTasks(ctx.db)) {
    if (t.state !== "done" && t.state !== "cancelled") continue;
    removed.push(...releaseTaskWorktrees(ctx, t.id).removed);
  }
  const worktrees = join(ctx.home, "worktrees");
  if (existsSync(worktrees)) {
    for (const project of readdirSync(worktrees)) {
      const dir = join(worktrees, project);
      if (!statSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name.startsWith("_profile-") && statSync(p).isDirectory() && readdirSync(p).length === 0) rmdirSync(p);
      }
    }
  }
  const tmp = join(ctx.home, "tmp");
  if (existsSync(tmp)) {
    for (const name of readdirSync(tmp)) {
      const p = join(tmp, name);
      if (now - statSync(p).mtimeMs > TMP_MAX_AGE_MS) rmSync(p, { recursive: true, force: true });
    }
  }
  return { removed };
}
