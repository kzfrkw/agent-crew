import { addEvent, listTaskRepos, type Task } from "../db/store.ts";
import { commitsSince, headSha, isDirty } from "../git/worktree.ts";
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

/** 状態ごとの処理。まだ無い役割の状態では、タスクは進まない */
export const HANDLERS: Partial<Record<Role, Handler>> = { planner, implementer };
