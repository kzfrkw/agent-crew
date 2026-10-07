import { addEvent, listTaskRepos, type Task } from "../db/store.ts";
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

/** 状態ごとの処理。まだ無い役割の状態では、タスクは進まない */
export const HANDLERS: Partial<Record<Role, Handler>> = { planner };
