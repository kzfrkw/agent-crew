import { addEvent } from "../db/store.ts";
import { installAgentHooks } from "../git/hooks.ts";
import type { AppContext } from "./context.ts";
import { requestStop, runnableTasks, stepTask } from "./engine.ts";
import { acquireRunLock, recoverStaleRuns } from "./lock.ts";
import { quotaBlock, type QuotaBlock } from "./usage.ts";
import { sweepFinishedWorktrees } from "./cleanup-worktrees.ts";
import { notifyHuman } from "./notify.ts";
import { appStageBusy } from "./overlap.ts";

/**
 * 常駐ワーカー(設計メモ14章 v0.10)。serve の中でオーケストレーターを動かし、進められるタスクを自動で進める。
 * - CLI の `agent-crew run` とは run.lock で排他する。取れなければ locked として、一定間隔で取り直す
 * - 一時停止中は新しい役割を起動せず、実行中のものが終わったらロックを外す(CLI の run を使える)
 * - 人の操作の直後は kick ですぐ見直す。それ以外は pollMs ごとに見直す(ほかのプロセスでの変更を拾う)
 */

export type WorkerState = "running" | "paused" | "locked";
/** quota は利用枠による自動の一時停止(人の一時停止とは別。リセットの時刻を過ぎたら自動で動く) */
export type WorkerStatus = { state: WorkerState; active: number[]; quota?: QuotaBlock };

/** 同じタスクを短い間に何度も進めていたら、状態遷移がループしているとみなして休ませる */
const LOOP_WINDOW_MS = 60_000;
const LOOP_MAX_STEPS = 30;

export class Worker {
  private readonly ctx: AppContext;
  private readonly pollMs: number;
  private state: WorkerState = "paused";
  private release: (() => void) | undefined;
  private readonly active = new Map<number, Promise<void>>();
  private readonly history = new Map<number, number[]>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private idleWaiters: (() => void)[] = [];
  private quota: QuotaBlock | undefined;

  /** 利用枠で自動の一時停止に入ったとき(通知などに使う。7-3) */
  onQuotaPaused?: (q: QuotaBlock) => void;

  constructor(ctx: AppContext, o: { pollMs?: number } = {}) {
    this.ctx = ctx;
    this.pollMs = o.pollMs ?? 5000;
  }

  start(): void {
    this.resume();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref();
  }

  status(): WorkerStatus {
    return { state: this.state, active: [...this.active.keys()], ...(this.quota ? { quota: this.quota } : {}) };
  }

  /** 人の操作の直後などに、すぐ見直す */
  kick(): void {
    queueMicrotask(() => this.tick());
  }

  /** 新しい役割を起動しない。実行中の役割が終わるとロックを外す(戻り値はそのときに解決する) */
  pause(): Promise<void> {
    this.state = "paused";
    return this.whenIdle().then(() => this.unlock());
  }

  resume(): void {
    if (this.closed) return;
    this.state = "running";
    this.lock();
    this.tick();
  }

  /** 実行中の役割を止め、終わるのを待ってからロックを外す(serve の終了時) */
  async close(): Promise<void> {
    this.closed = true;
    this.state = "paused";
    clearInterval(this.timer);
    for (const id of this.active.keys()) requestStop(this.ctx, id);
    await this.whenIdle();
    this.unlock();
  }

  private lock(): void {
    if (this.release) return;
    try {
      this.release = acquireRunLock(this.ctx.home);
    } catch {
      this.state = "locked";
      return;
    }
    const stale = recoverStaleRuns(this.ctx.db);
    if (stale) addEvent(this.ctx.db, { kind: "warning", payload: { message: `前回中断された実行を ${stale} 件、失敗として記録しました` } });
    // フックは全worktreeで共有するので、ツールの更新が既存のworktreeにも効くよう起動ごとに書き直す
    installAgentHooks(this.ctx.home);
    // すでに終わったタスクの worktree と、古い一時ディレクトリを片付ける(設計メモ v0.17)
    try {
      sweepFinishedWorktrees(this.ctx);
    } catch (e) {
      addEvent(this.ctx.db, { kind: "warning", payload: { message: `片付けに失敗しました: ${(e as Error).message}` } });
    }
  }

  private unlock(): void {
    if (this.state === "running" || this.active.size > 0) return;
    this.release?.();
    this.release = undefined;
  }

  private whenIdle(): Promise<void> {
    return this.active.size === 0 ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r));
  }

  private tick(): void {
    if (this.closed) return;
    if (this.state === "locked") {
      this.state = "running";
      this.lock();
    }
    if (this.state !== "running") return;
    // 利用枠の上限の間は新しい役割を起動しない。止め始めと再開を1回ずつ記録する(設計メモ v0.17)
    let quota: QuotaBlock | null;
    try {
      quota = quotaBlock(this.ctx);
    } catch {
      return;
    }
    if (quota) {
      if (!this.quota || this.quota.until !== quota.until) {
        addEvent(this.ctx.db, { kind: "quota_paused", payload: { reason: quota.reason, until: new Date(quota.until).toISOString() } });
        this.onQuotaPaused?.(quota);
        notifyHuman(this.ctx, `${quota.reason}。自動実行を一時停止しました(${new Date(quota.until).toLocaleString("ja-JP")} に再開)`);
      }
      this.quota = quota;
      return;
    }
    if (this.quota) {
      addEvent(this.ctx.db, { kind: "quota_resumed", payload: {} });
      this.quota = undefined;
    }
    let tasks;
    try {
      tasks = runnableTasks(this.ctx);
    } catch {
      return; // DB の一時的なロックなどは次の回で拾う
    }
    for (const t of tasks) {
      if (this.active.size >= this.ctx.config.concurrency) break;
      if (this.active.has(t.id) || this.looping(t.id)) continue;
      if (appStageBusy(this.ctx.db, t, this.active.keys())) continue;
      const p = stepTask(this.ctx, t.id).finally(() => {
        this.active.delete(t.id);
        if (this.active.size === 0) for (const w of this.idleWaiters.splice(0)) w();
        // 1段進んだら、続きをすぐ見る(承認待ちなどで止まるまで進める)
        this.tick();
      });
      this.active.set(t.id, p);
    }
  }

  private looping(taskId: number): boolean {
    const now = Date.now();
    const recent = (this.history.get(taskId) ?? []).filter((t) => now - t < LOOP_WINDOW_MS);
    if (recent.length >= LOOP_MAX_STEPS) {
      if (recent.length === LOOP_MAX_STEPS) {
        addEvent(this.ctx.db, { taskId, kind: "warning", payload: { message: "短い間に同じタスクを何度も進めています。状態遷移がループしていないか確認してください(1分休みます)" } });
        recent.push(now);
        this.history.set(taskId, recent);
      }
      return true;
    }
    recent.push(now);
    this.history.set(taskId, recent);
    return false;
  }
}
