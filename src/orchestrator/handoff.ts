import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addEvent, getRepo, getTask, listEvents, listTaskRepos } from "../db/store.ts";
import { git } from "../git/git.ts";
import { commitsSince, containsRef, diffFromBase, diffStat, headSha, isDirty } from "../git/worktree.ts";
import type { AppContext } from "./context.ts";
import { applyEvent, runActive } from "./engine.ts";
import { agentGitEnv } from "./handlers.ts";
import { appendHumanNote } from "./human.ts";
import { taskDir } from "./paths.ts";

/**
 * 人による手作業との引き継ぎ(設計メモ5.2)。エージェントと人は同じworktreeで交互に作業する。
 */

/** 人が引き取る。エージェントは起動しなくなる。引き取った時点の HEAD を記録して、戻すときに人の変更を見分ける */
export function takeoverTask(ctx: AppContext, taskId: number): { worktrees: string[] } {
  applyEvent(ctx, taskId, { type: "takeover" });
  const trs = listTaskRepos(ctx.db, taskId);
  const heads = Object.fromEntries(trs.map((tr) => [tr.repoId, headSha(tr.worktreePath, ctx.gitEnv)]));
  addEvent(ctx.db, { taskId, kind: "human_takeover", payload: { heads } });
  return { worktrees: trs.map((tr) => tr.worktreePath) };
}

/** エージェントに戻す。未コミットの変更があれば拒否する。人の変更があれば、承認を失効させてレビューからやり直す */
export function returnTask(ctx: AppContext, taskId: number): { humanChanged: boolean; commits: string[] } {
  const task = getTask(ctx.db, taskId);
  if (task?.state !== "human_working") throw new Error(`タスク ${taskId} は人が作業中ではありません`);
  const trs = listTaskRepos(ctx.db, taskId);
  for (const tr of trs) {
    if (isDirty(tr.worktreePath, ctx.gitEnv)) {
      throw new Error(`未コミットの変更があります(${tr.worktreePath})。コミットしてから戻してください`);
    }
  }
  const takeover = listEvents(ctx.db, taskId, 1000).filter((e) => e.kind === "human_takeover").at(-1);
  const heads = ((takeover?.payload as { heads?: Record<string, string> }) ?? {}).heads ?? {};

  const sections: string[] = [];
  const commits: string[] = [];
  for (const tr of trs) {
    const from = heads[String(tr.repoId)];
    if (!from) continue;
    const added = commitsSince(tr.worktreePath, from, ctx.gitEnv);
    if (added.length === 0) continue;
    commits.push(...added.map((c) => `${c.sha.slice(0, 12)} ${c.subject}`));
    sections.push(
      `## ${getRepo(ctx.db, tr.repoId)?.role ?? tr.repoId}(${tr.worktreePath})`,
      "",
      "### コミット",
      ...added.map((c) => `- ${c.sha.slice(0, 12)} ${c.subject}(${c.author})`),
      "",
      "### 変更の概要",
      "```",
      diffStat(tr.worktreePath, from, ctx.gitEnv),
      "```",
      "",
      "### 差分",
      "```diff",
      diffFromBase(tr.worktreePath, from, ctx.gitEnv),
      "```",
      "",
    );
  }
  const humanChanged = commits.length > 0;
  if (humanChanged) {
    const dir = taskDir(ctx.home, taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "human-changes.md"), `# 人の変更\n\n人が引き取って加えた変更です。エージェントの変更と同じ基準で扱ってください。\n\n${sections.join("\n")}`);
    appendHumanNote(ctx, taskId, "人が変更しました", `人が引き取って変更しました(詳細: human-changes.md)。レビューからやり直します。\n${commits.map((c) => `- ${c}`).join("\n")}`);
  }
  applyEvent(ctx, taskId, { type: "return", humanChanged });
  addEvent(ctx.db, { taskId, kind: "human_returned", payload: { commits } });
  return { humanChanged, commits };
}

/** ベース(既定ブランチ)をタスクのブランチに取り込む。衝突したら中止して人に任せる */
export function updateBase(ctx: AppContext, taskId: number): { updated: boolean; conflict?: boolean; message: string } {
  const task = getTask(ctx.db, taskId);
  if (!task) throw new Error(`タスク ${taskId} がありません`);
  if (task.state === "human_working") throw new Error("人が作業中です。人が自分で取り込むか、エージェントに戻してから実行してください");
  if (task.state === "done" || task.state === "cancelled") throw new Error("終了したタスクです");
  if (runActive(ctx.db, taskId)) throw new Error("エージェントが実行中です");
  const env = { ...ctx.gitEnv, ...agentGitEnv("base-update") };
  let updated = false;
  for (const tr of listTaskRepos(ctx.db, taskId)) {
    const repo = getRepo(ctx.db, tr.repoId)!;
    if (isDirty(tr.worktreePath, ctx.gitEnv)) throw new Error(`未コミットの変更があります: ${tr.worktreePath}`);
    if (containsRef(tr.worktreePath, repo.defaultBranch, ctx.gitEnv)) continue;
    try {
      git(tr.worktreePath, ["merge", "--no-edit", repo.defaultBranch], env);
      updated = true;
    } catch {
      try {
        git(tr.worktreePath, ["merge", "--abort"], ctx.gitEnv);
      } catch {
        // マージが始まっていなければ中止するものは無い
      }
      const reason = `ベース(${repo.defaultBranch})の取り込みで衝突しました。agent-crew task takeover ${taskId} で引き取り、worktree で解決してください: ${tr.worktreePath}`;
      applyEvent(ctx, taskId, { type: "base_conflict", reason }, reason);
      return { updated: false, conflict: true, message: reason };
    }
  }
  if (!updated) return { updated: false, message: "すでにベースに追従しています" };
  const next = applyEvent(ctx, taskId, { type: "base_updated" });
  return { updated: true, message: next.state === "reviewing" ? "ベースを取り込みました。レビューからやり直します" : "ベースを取り込みました" };
}
