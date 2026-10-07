import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { addApproval, addEvent, getRepo, listTaskRepos, type Task } from "../db/store.ts";
import { changedFiles, commitsSince, diffFromBase, headSha, isDirty, mergeBase } from "../git/worktree.ts";
import { detectTestChanges, renderTestChanges } from "./test-changes.ts";
import { verifyTests } from "./verify.ts";
import type { AppContext } from "./context.ts";
import { invokeRole, type InvokeResult } from "./invoke.ts";
import { taskDir } from "./paths.ts";
import { taskPrompt } from "./prompts.ts";
import type { Role, TaskEvent } from "./transitions.ts";

export type HandlerOutcome = { event: TaskEvent; reason?: string };
export type Handler = (ctx: AppContext, task: Task) => Promise<HandlerOutcome>;

/** 役割の実行結果を、状態遷移の出来事にする */
export function outcomeOf(r: InvokeResult, role: Role, artifactPath?: string): HandlerOutcome {
  if (!r.ok) return { event: r.failure === "limit" ? { type: "limit_exceeded", reason: r.reason } : { type: "run_error", reason: r.reason }, reason: `${role}: ${r.reason}` };
  return {
    event: { type: "verdict", role, verdict: r.verdict },
    reason: `${role} の判定: ${r.verdict} — ${r.summary}${artifactPath ? `(詳細: ${artifactPath})` : ""}`,
  };
}

/** フェーズ1は1リポジトリ。複数リポジトリ対応(フェーズ5)では役目ごとに実装者を順に動かす */
export function primaryRepo(ctx: AppContext, task: Task) {
  const tr = listTaskRepos(ctx.db, task.id)[0];
  if (!tr) throw new Error(`タスク ${task.id} の worktree がありません`);
  return tr;
}

const planner: Handler = async (ctx, task) => {
  const tr = primaryRepo(ctx, task);
  const dir = taskDir(ctx.home, task.id);
  const r = await invokeRole(ctx, { roleName: "planner", taskId: task.id, cwd: tr.worktreePath, artifactsDir: dir, prompt: taskPrompt(ctx, task, "planner") });
  if (r.ok) addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "plan", payload: r.extra });
  return outcomeOf(r, "planner", `${dir}/plan.md`);
};

/** エージェントのコミットを人のコミットと区別するための作者と目印(trailer はフックが付ける) */
export function agentGitEnv(role: string): Record<string, string> {
  const name = `agent-crew ${role}`;
  const email = "agent-crew@localhost";
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, AGENT_CREW_ROLE: role };
}

const implementer: Handler = async (ctx, task) => {
  const tr = primaryRepo(ctx, task);
  const dir = taskDir(ctx.home, task.id);
  const before = headSha(tr.worktreePath, ctx.gitEnv);
  const r = await invokeRole(ctx, {
    roleName: "implementer",
    taskId: task.id,
    cwd: tr.worktreePath,
    artifactsDir: dir,
    prompt: taskPrompt(ctx, task, "implementer"),
    extraEnv: agentGitEnv("implementer"),
  });
  if (r.ok && r.verdict === "done") {
    // 実装者の申告ではなく、worktree の実際の状態で確かめる
    if (isDirty(tr.worktreePath, ctx.gitEnv)) {
      return { event: { type: "run_error", reason: "未コミットの変更が残っています" }, reason: `implementer: 未コミットの変更が残っています(${tr.worktreePath})` };
    }
    const commits = commitsSince(tr.worktreePath, before, ctx.gitEnv);
    if (commits.length === 0) return { event: { type: "run_error", reason: "コミットがありません" }, reason: "implementer: done と判定しましたが、コミットがありません" };
    addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "implemented", payload: { commits: commits.map((c) => ({ sha: c.sha, subject: c.subject })) } });
    const testCommand = r.extra.testCommand;
    if (typeof testCommand === "string" && testCommand.trim()) {
      addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "test_command", payload: { command: testCommand.trim() } });
    }
  }
  return outcomeOf(r, "implementer", `${dir}/impl-notes.md`);
};

/** レビュワー: テストを再実行してから、差分・テストの変更の検出結果・人の変更を材料にレビューさせる */
const reviewer: Handler = async (ctx, task) => {
  const v = await verifyTests(ctx, task);
  if (v.status === "error") return { event: { type: "run_error", reason: v.reason }, reason: `verifier: ${v.reason}` };
  if (v.status === "failed") return { event: { type: "tests_failed" }, reason: `テストの再実行が失敗しました(詳細: ${v.reportPath})` };

  const tr = primaryRepo(ctx, task);
  const repo = getRepo(ctx.db, tr.repoId)!;
  const dir = taskDir(ctx.home, task.id);
  const base = mergeBase(tr.worktreePath, repo.defaultBranch, ctx.gitEnv);
  const diff = diffFromBase(tr.worktreePath, base, ctx.gitEnv);
  writeFileSync(join(dir, "diff.patch"), diff);
  writeFileSync(join(dir, "test-changes.md"), renderTestChanges(detectTestChanges({ nameStatus: changedFiles(tr.worktreePath, base, ctx.gitEnv), diff })));
  const human = commitsSince(tr.worktreePath, base, ctx.gitEnv).filter((c) => !c.agentRole);
  const head = headSha(tr.worktreePath, ctx.gitEnv);

  const r = await invokeRole(ctx, {
    roleName: "reviewer",
    taskId: task.id,
    cwd: tr.worktreePath,
    artifactsDir: dir,
    prompt: taskPrompt(ctx, task, "reviewer", [
      `- 差分(ベース ${base.slice(0, 12)} から HEAD ${head.slice(0, 12)}): ${join(dir, "diff.patch")}`,
      `- テストの変更の検出結果(必ず確認する): ${join(dir, "test-changes.md")}`,
      `- テストの再実行: ${v.status === "passed" ? `成功(${v.command})` : "テストコマンドが無いため未確認"}`,
      ...(human.length
        ? ["- 人の変更が含まれます(同じ基準でレビューする):", ...human.map((c) => `  - ${c.sha.slice(0, 12)} ${c.subject}(${c.author})`)]
        : []),
    ]),
  });
  if (r.ok && r.verdict === "approve") {
    addApproval(ctx.db, { taskId: task.id, repoId: tr.repoId, kind: "review", result: "approved", commitSha: head });
  }
  return outcomeOf(r, "reviewer", `${dir}/review.md`);
};

/** 状態ごとの処理。まだ無い役割の状態では、タスクは進まない */
export const HANDLERS: Partial<Record<Role, Handler>> = { planner, implementer, reviewer };
