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
  listChildren,
  type Task,
} from "../db/store.ts";
import { installAgentHooks } from "../git/hooks.ts";
import { branchNameFor, createWorktree, worktreePathFor } from "../git/worktree.ts";
import type { AppContext } from "./context.ts";
import { quotaBlock, QuotaError, type QuotaBlock } from "./usage.ts";
import { releaseTaskWorktrees, sweepFinishedWorktrees } from "./cleanup-worktrees.ts";
import { notifyHuman } from "./notify.ts";
import { recordBounce } from "./bounce.ts";
import { appStageBusy, overlapBlocker } from "./overlap.ts";
import { decideAutoApprove } from "./auto-approve.ts";
import { approveTask } from "./human.ts";
import { NEEDS_HUMAN, STATE_LABELS } from "./states.ts";
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
/** quiet: 人への通知を出さない(すぐ自動で承認するときなど) */
export function applyEvent(ctx: AppContext, taskId: number, event: TaskEvent, reason?: string, o: { quiet?: boolean } = {}): TransitionResult {
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
  updateTaskState(ctx.db, taskId, { state: next.state, heldFromState: next.heldFromState, assignee: next.assignee, reviewRounds: next.reviewRounds, design: next.design });
  addEvent(ctx.db, { taskId, kind: "state_changed", payload: { from: task.state, to: next.state, event: event.type, ...(reason ? { reason } : {}) } });
  if (next.state === "needs_input" || next.state === "failed") {
    addEvent(ctx.db, { taskId, kind: next.state, payload: { reason: reason ?? describeEvent(event) } });
  }
  // 人の対応待ちになったら知らせる(設計メモ v0.17)
  if (!o.quiet && NEEDS_HUMAN.includes(next.state) && task.state !== next.state) notifyHuman(ctx, `#${taskId} ${STATE_LABELS[next.state]}: ${task.title}`);
  // 分割の子が完了・取り消しになったら、親に知らせる(8-2)
  if (task.parentId !== null && task.state !== next.state && (next.state === "done" || next.state === "cancelled")) notifyParent(ctx, task.parentId, next.state, task);
  // 完了・取り消しになったら worktree を片付ける(ブランチは残す。設計メモ v0.17)
  if ((next.state === "done" || next.state === "cancelled") && task.state !== next.state) releaseTaskWorktrees(ctx, taskId);
  return next;
}

function notifyParent(ctx: AppContext, parentId: number, state: "done" | "cancelled", child: Task): void {
  const parent = getTask(ctx.db, parentId);
  if (parent?.state !== "split") return;
  if (state === "cancelled") {
    const reason = `子タスク #${child.id}(${child.title})が取り消されました。続けるか(回答)、親を取り消すかを決めてください`;
    applyEvent(ctx, parentId, { type: "child_cancelled", reason }, reason);
    return;
  }
  if (listChildren(ctx.db, parentId).every((c) => c.id === child.id || c.state === "done")) applyEvent(ctx, parentId, { type: "children_done" }, "子タスクがすべて完了しました");
}

function describeEvent(e: TaskEvent): string {
  switch (e.type) {
    case "verdict":
      return `${e.role} の判定: ${e.verdict}`;
    case "limit_exceeded":
    case "run_error":
    case "fail":
    case "repeated_failure":
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
      // 分割の子は順に進める: 前の子が完了するまで始めない(8-2)
      if (t.parentId !== null && (t.seq ?? 1) > 1) {
        const prev = listChildren(ctx.db, t.parentId).find((c) => c.seq === (t.seq ?? 1) - 1);
        if (prev && prev.state !== "done") return false;
      }
      return getProject(ctx.db, t.projectId)?.profileStatus === "approved" && testGateOpen(ctx.db, t.id);
    }
    const role = roleForState(t.state);
    if (role === null || HANDLERS[role] === undefined || runActive(ctx.db, t.id)) return false;
    // 変更するファイルが、先に進んでいるタスクと重なるなら、実装を始めない(8-4)
    // 確認 URL のポートでアプリを起動する段は、同じプロジェクトで1つずつ
    return !overlapBlocker(ctx.db, t) && !appStageBusy(ctx.db, t, ctx.stops?.keys() ?? []);
  });
}

/** タスクのベース: 分割の2つ目以降の子は、前の子のブランチ。それ以外はリポジトリの既定ブランチ(8-2) */
export function baseRefFor(ctx: AppContext, task: Task, repo: { id: number; defaultBranch: string }): string {
  if (task.parentId === null || (task.seq ?? 1) <= 1) return repo.defaultBranch;
  const prev = listChildren(ctx.db, task.parentId).find((c) => c.seq === (task.seq ?? 1) - 1);
  const tr = prev ? listTaskRepos(ctx.db, prev.id).find((x) => x.repoId === repo.id) : undefined;
  return tr?.branchName ?? repo.defaultBranch;
}

/** タスクのworktreeを用意する(プロジェクトの全リポジトリ。フェーズ1は1つ) */
export function ensureWorktrees(ctx: AppContext, task: Task, roles?: string[]): void {
  const project = getProject(ctx.db, task.projectId)!;
  const existing = new Set(listTaskRepos(ctx.db, task.id).map((tr) => tr.repoId));
  const branch = branchNameFor(task.id, task.title);
  const repos = listRepos(ctx.db, project.id).filter((r) => roles === undefined || roles.includes(r.role));
  for (const repo of repos) {
    if (existing.has(repo.id)) continue;
    const worktreePath = worktreePathFor(ctx.home, { project: project.name, taskId: task.id, repoRole: repo.role });
    const { baseSha } = createWorktree({ home: ctx.home, repoPath: repo.path, worktreePath, branch, base: baseRefFor(ctx, task, repo), env: ctx.gitEnv });
    attachRepoToTask(ctx.db, { taskId: task.id, repoId: repo.id, worktreePath, branchName: branch, baseSha });
  }
}

/**
 * 実行中の役割を止める(設計メモ14章 v0.10)。このプロセスで進めているタスクだけが対象。
 * 止めたら、stepTask がタスクを人の判断待ちにする
 */
export function requestStop(ctx: AppContext, taskId: number): boolean {
  const ac = ctx.stops?.get(taskId);
  if (!ac) return false;
  ac.abort();
  return true;
}

const STOPPED_REASON = "人が停止しました。続けるなら回答して再開するか、引き取って直してください";

/** タスクを1段進める */
export async function stepTask(ctx: AppContext, taskId: number): Promise<void> {
  const ac = new AbortController();
  (ctx.stops ??= new Map()).set(taskId, ac);
  try {
    await stepTaskInner(ctx, taskId, ac.signal);
  } finally {
    ctx.stops.delete(taskId);
  }
}

async function stepTaskInner(ctx: AppContext, taskId: number, signal: AbortSignal): Promise<void> {
  const task = getTask(ctx.db, taskId)!;
  // 止められたら、役割の結果(失敗として返ってくる)ではなく「人が停止した」として扱う
  const stoppedIfAborted = () => {
    if (!signal.aborted) return false;
    applyEvent(ctx, taskId, { type: "stopped" }, STOPPED_REASON);
    return true;
  };
  try {
    if (task.state === "queued") {
      // 複数リポジトリのプロジェクトは、計画で変更するリポジトリを決めてから worktree を作る(設計メモ v0.14)
      if (listRepos(ctx.db, task.projectId).length === 1) ensureWorktrees(ctx, task);
      applyEvent(ctx, taskId, { type: "start" });
      return;
    }
    const role = roleForState(task.state);
    const handler = role ? HANDLERS[role] : undefined;
    if (!handler) return;
    const { event, reason, bounce } = await handler(ctx, task);
    if (stoppedIfAborted()) return;
    // 同じ理由の差し戻しが続いたら、上限を待たずに人に回す(設計メモ v0.18)
    if (bounce) {
      const { repeated } = recordBounce(ctx.db, taskId, bounce);
      if (repeated) {
        const why = `同じ理由で2回差し戻されました。人の判断が必要です(${bounce.summary})`;
        applyEvent(ctx, taskId, { type: "repeated_failure", reason: why }, why);
        return;
      }
    }
    // 小さなタスクの計画は、プロジェクトでオンなら自動で承認する(設計メモ v0.18)
    if (event.type === "verdict" && event.role === "planner" && event.verdict === "ready" && decideAutoApprove(ctx, taskId)) {
      applyEvent(ctx, taskId, event, reason, { quiet: true });
      approveTask(ctx, taskId, "plan", "自動承認(小さなタスク。条件はタスクのアクティビティを参照。設計メモ v0.18)");
      return;
    }
    applyEvent(ctx, taskId, event, reason);
  } catch (e) {
    if (stoppedIfAborted()) return;
    // 利用枠で止まったら、状態を変えずに待つ(リセットの後に同じ段をやり直す)
    if (e instanceof QuotaError) {
      addEvent(ctx.db, { taskId, kind: "quota_wait", payload: { reason: e.block.reason, until: new Date(e.block.until).toISOString() } });
      return;
    }
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
export async function runUntilIdle(ctx: AppContext, o: { maxSteps?: number; onStep?: (taskId: number) => void } = {}): Promise<{ steps: number; quota?: QuotaBlock }> {
  // フックは全worktreeで共有するので、ツールの更新が既存のworktreeにも効くよう毎回書き直す
  installAgentHooks(ctx.home);
  sweepFinishedWorktrees(ctx);
  const active = new Map<number, Promise<void>>();
  let steps = 0;
  const maxSteps = o.maxSteps ?? 500;
  for (;;) {
    // 利用枠の上限の間は新しい段を始めない。実行中のものが終わるのを待って、理由を返す
    const quota = quotaBlock(ctx);
    if (quota) {
      await Promise.all(active.values());
      return { steps, quota };
    }
    for (const t of runnableTasks(ctx)) {
      if (active.size >= ctx.config.concurrency) break;
      if (active.has(t.id)) continue;
      // 同じ回で先に始めたタスクと、アプリを起動する段がぶつからないか(8-4)
      if (appStageBusy(ctx.db, t, active.keys())) continue;
      if (++steps > maxSteps) throw new Error(`処理の上限(${maxSteps}回)に達しました。状態遷移がループしていないか確認してください`);
      o.onStep?.(t.id);
      active.set(t.id, stepTask(ctx, t.id).finally(() => active.delete(t.id)));
    }
    if (active.size === 0) return { steps };
    await Promise.race(active.values());
  }
}
