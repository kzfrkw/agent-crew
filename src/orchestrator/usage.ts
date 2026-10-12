import type { Db } from "../db/connection.ts";
import { getAppState, setAppState } from "../db/store.ts";
import type { AppContext } from "./context.ts";

/**
 * 利用枠(設計メモ v0.17、7-1)。claude の stream の rate_limit_event に入る、5時間と7日の窓ごとの使用率とリセットの時刻を残し、
 * 上限に近づいたら新しい役割を起動しない(自動の一時停止)。リセットの時刻を過ぎたら自動で再開する。
 */

export type UsageWindow = { utilization: number; resetsAt: number };
/** limitedBy は上限に達した窓(rate_limit の rateLimitType) */
export type Usage = { status: string; windows: Partial<Record<"five_hour" | "seven_day", UsageWindow>>; limitedBy?: string; updatedAt: number };
export type QuotaBlock = { until: number; window: string; reason: string };

const KEY = "usage";
const WINDOW_LABELS: Record<string, string> = { five_hour: "5時間", seven_day: "7日" };

type RateLimitInfo = { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown; unifiedWindows?: Record<string, { utilization?: unknown; resetsAt?: unknown }> };

/** rate_limit の値(秒の時刻)を残す。読めない値は無視する */
export function recordUsage(db: Db, payload: unknown, now = Date.now()): void {
  const p = (payload ?? {}) as RateLimitInfo;
  if (typeof p.status !== "string") return;
  const windows: Usage["windows"] = {};
  for (const key of ["five_hour", "seven_day"] as const) {
    const w = p.unifiedWindows?.[key];
    if (w && typeof w.utilization === "number" && typeof w.resetsAt === "number") windows[key] = { utilization: w.utilization, resetsAt: w.resetsAt * 1000 };
  }
  // 窓ごとの値が無い形でも、状態とリセットの時刻だけは使う
  if (Object.keys(windows).length === 0 && typeof p.resetsAt === "number") {
    const key = p.rateLimitType === "seven_day" ? "seven_day" : "five_hour";
    windows[key] = { utilization: p.status === "rejected" ? 1 : 0, resetsAt: p.resetsAt * 1000 };
  }
  const limitedBy = p.status === "rejected" && typeof p.rateLimitType === "string" ? p.rateLimitType : undefined;
  setAppState(db, KEY, { status: p.status, windows, ...(limitedBy ? { limitedBy } : {}), updatedAt: now } satisfies Usage);
}

export function getUsage(db: Db): Usage | null {
  return getAppState<Usage>(db, KEY);
}

/** 新しい役割を起動しないか(止めるならリセットの時刻と理由)。リセットの時刻を過ぎた窓は数えない */
export function quotaBlock(ctx: AppContext, now = Date.now()): QuotaBlock | null {
  const u = getUsage(ctx.db);
  if (!u) return null;
  const limit = ctx.config.limits.pauseAtUtilization;
  const live = Object.entries(u.windows).filter(([, w]) => w.resetsAt > now);
  // rejected なら上限に達した窓(分からなければ使用率の高い窓)、そうでなければ上限を超えた窓のうちリセットの遅いもの
  const hit =
    u.status === "rejected"
      ? (live.find(([k]) => k === u.limitedBy) ?? [...live].sort(([, a], [, b]) => b.utilization - a.utilization)[0])
      : live.filter(([, w]) => w.utilization >= limit).sort(([, a], [, b]) => b.resetsAt - a.resetsAt)[0];
  if (!hit) return null;
  const [window, w] = hit;
  const pct = Math.round(w.utilization * 100);
  const reason = u.status === "rejected" ? `利用枠(${WINDOW_LABELS[window] ?? window})の上限に達しました` : `利用枠(${WINDOW_LABELS[window] ?? window})の使用率が ${pct}% です(上限 ${Math.round(limit * 100)}%)`;
  return { until: w.resetsAt, window, reason };
}

/** 利用枠で止まった役割(失敗にせず、タスクを同じ状態のまま待たせる) */
export class QuotaError extends Error {
  readonly block: QuotaBlock;
  constructor(block: QuotaBlock) {
    super(`${block.reason}。${new Date(block.until).toLocaleString("ja-JP")} に再開します`);
    this.block = block;
  }
}

/** 実行の失敗が利用枠によるものか(エラーの文面か、実行中に rejected が来たか) */
export function isQuotaFailure(error: string | undefined, sawRejected: boolean): boolean {
  return sawRejected || /usage limit|rate.?limit|limit reached|limit exceeded|hit your limit/i.test(error ?? "");
}
