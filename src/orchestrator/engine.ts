import type { Db } from "../db/connection.ts";
import {
  addEvent,
  attachRepoToTask,
  getProject,
  getTask,
  invalidateApprovals,
  listEvents,
  listRepos,
  listTaskRepos,
  listTasks,
  updateTaskState,
  type Task,
} from "../db/store.ts";
import { installAgentHooks } from "../git/hooks.ts";
import { branchNameFor, createWorktree, worktreePathFor } from "../git/worktree.ts";
import type { AppContext } from "./context.ts";
import { HANDLERS } from "./handlers.ts";
import { testGateOpen } from "./projects.ts";
import { roleForState, transition, type TaskEvent, type TransitionResult } from "./transitions.ts";

/** このタスクのエージェントが実行中か(runs に running が残っているか) */
export function runActive(db: Db, taskId: number): boolean {
  return db.prepare("SELECT 1 FROM runs WHERE task_id = ? AND state = 'running' LIMIT 1").get(taskId) !== undefined;
}

/**
 * 出来事を状態遷移に通し、結果をDBに反映する。遷移の正しさは transitions.ts だけが決める。
 * reason は needs_input / failed になったときに人へ見せる理由。
 */
export function applyEvent(ctx: AppContext, taskId: number, event: TaskEvent, reason?: string): TransitionResult {
  const task = getTask(ctx.db, taskId);
  if (!task) throw new Error(`タスク ${taskId} がありません`);
  const next = transition(task, event, {
    maxReviewRounds: ctx.config.limits.maxReviewRounds,
    runActive: runActive(ctx.db, taskId),
    testGateOpen: testGateOpen(ctx.db, taskId),
  });
  for (const effect of next.effects) {
    if (effect.type === "invalidate_approvals") invalidateApprovals(ctx.db, taskId, effect.kinds);
  }
  updateTaskState(ctx.db, taskId, { state: next.state, heldFromState: next.heldFromState, assignee: next.assignee, reviewRounds: next.reviewRounds });
  addEvent(ctx.db, { taskId, kind: "state_changed", payload: { from: task.state, to: next.state, event: event.type, ...(reason ? { reason } : {}) } });
  if (next.state === "needs_input" || next.state === "failed") {
    addEvent(ctx.db, { taskId, kind: next.state, payload: { reason: reason ?? describeEvent(event) } });
  }
  return next;
}

function describeEvent(e: TaskEvent): string {
  switch (e.type) {
    case "verdict":
      return `${e.role} の判定: ${e.verdict}`;
    case "limit_exceeded":
    case "run_error":
    case "fail":
      return e.reason;
    default:
      return e.type;
  }
}

/** 直近の needs_input / failed の理由 */
export function latestReason(db: Db, taskId: number, kind: "needs_input" | "failed"): string | undefined {
  const ev = listEvents(db, taskId, 1000).filter((e) => e.kind === kind).at(-1);
  return (ev?.payload as { reason?: string } | undefined)?.reason;
}

/** 直近の needs_input の理由 */
export function latestNeedsInputReason(db: Db, taskId: number): string | undefined {
  return latestReason(db, taskId, "needs_input");
}

/** エージェントが進められるタスク */
export function runnableTasks(ctx: AppContext): Task[] {
  return listTasks(ctx.db).filter((t) => {
    if (t.state === "queued") {
      return getProject(ctx.db, t.projectId)?.profileStatus === "approved" && testGateOpen(ctx.db, t.id);
    }
    const role = roleForState(t.state);
    return role !== null && HANDLERS[role] !== undefined && !runActive(ctx.db, t.id);
  });
}

/** タスクのworktreeを用意する(プロジェクトの全リポジトリ。フェーズ1は1つ) */
export function ensureWorktrees(ctx: AppContext, task: Task): void {
  if (listTaskRepos(ctx.db, task.id).length > 0) return;
  const project = getProject(ctx.db, task.projectId)!;
  const branch = branchNameFor(task.id, task.title);
  for (const repo of listRepos(ctx.db, project.id)) {
    const worktreePath = worktreePathFor(ctx.home, { project: project.name, taskId: task.id, repoRole: repo.role });
    const { baseSha } = createWorktree({ home: ctx.home, repoPath: repo.path, worktreePath, branch, base: repo.defaultBranch, env: ctx.gitEnv });
    attachRepoToTask(ctx.db, { taskId: task.id, repoId: repo.id, worktreePath, branchName: branch, baseSha });
  }
}

/** タスクを1段進める */
export async function stepTask(ctx: AppContext, taskId: number): Promise<void> {
  const task = getTask(ctx.db, taskId)!;
  try {
    if (task.state === "queued") {
      ensureWorktrees(ctx, task);
      applyEvent(ctx, taskId, { type: "start" });
      return;
    }
    const role = roleForState(task.state);
    const handler = role ? HANDLERS[role] : undefined;
    if (!handler) return;
    const { event, reason } = await handler(ctx, task);
    applyEvent(ctx, taskId, event, reason);
  } catch (e) {
    const reason = `オーケストレーターのエラー: ${(e as Error).message}`;
    const current = getTask(ctx.db, taskId)!;
    try {
      applyEvent(ctx, taskId, roleForState(current.state) ? { type: "run_error", reason } : { type: "fail", reason }, reason);
    } catch {
      applyEvent(ctx, taskId, { type: "fail", reason }, reason);
    }
  }
}

/** 進められるタスクが無くなるまで、同時実行数の上限を守って進める */
export async function runUntilIdle(ctx: AppContext, o: { maxSteps?: number; onStep?: (taskId: number) => void } = {}): Promise<{ steps: number }> {
  // フックは全worktreeで共有するので、ツールの更新が既存のworktreeにも効くよう毎回書き直す
  installAgentHooks(ctx.home);
  const active = new Map<number, Promise<void>>();
  let steps = 0;
  const maxSteps = o.maxSteps ?? 500;
  for (;;) {
    for (const t of runnableTasks(ctx)) {
      if (active.size >= ctx.config.concurrency) break;
      if (active.has(t.id)) continue;
      if (++steps > maxSteps) throw new Error(`処理の上限(${maxSteps}回)に達しました。状態遷移がループしていないか確認してください`);
      o.onStep?.(t.id);
      active.set(t.id, stepTask(ctx, t.id).finally(() => active.delete(t.id)));
    }
    if (active.size === 0) return { steps };
    await Promise.race(active.values());
  }
}
