import { describe, expect, it } from "vitest";
import { getTask, listEvents, listRuns } from "../src/db/store.ts";
import { runUntilIdle } from "../src/orchestrator/engine.ts";
import { getUsage, quotaBlock, recordUsage } from "../src/orchestrator/usage.ts";
import { testContext } from "./helpers/context.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner } from "./helpers/scripted-runner.ts";

const NOW = Date.UTC(2026, 9, 12, 3, 0, 0);
const sec = (ms: number) => Math.floor(ms / 1000);
const info = (o: { status?: string; five?: number; week?: number; fiveReset?: number; weekReset?: number }) => ({
  status: o.status ?? "allowed",
  resetsAt: sec(o.fiveReset ?? NOW + 3_600_000),
  rateLimitType: "five_hour",
  unifiedWindows: {
    five_hour: { utilization: o.five ?? 0.3, resetsAt: sec(o.fiveReset ?? NOW + 3_600_000) },
    seven_day: { utilization: o.week ?? 0.2, resetsAt: sec(o.weekReset ?? NOW + 86_400_000 * 3) },
  },
});

describe("利用枠(7-1)", () => {
  it("rate_limit の最新の値を、窓ごとの使用率とリセットの時刻として残す", () => {
    const ctx = testContext(new ScriptedRunner({}));
    recordUsage(ctx.db, info({ five: 0.42, week: 0.18 }), NOW);
    expect(getUsage(ctx.db)).toEqual({
      status: "allowed",
      windows: { five_hour: { utilization: 0.42, resetsAt: sec(NOW + 3_600_000) * 1000 }, seven_day: { utilization: 0.18, resetsAt: sec(NOW + 86_400_000 * 3) * 1000 } },
      updatedAt: NOW,
    });
  });

  it("使用率が上限以上、または rejected なら、リセットの時刻まで止める。リセットを過ぎたら止めない", () => {
    const ctx = testContext(new ScriptedRunner({}));
    expect(quotaBlock(ctx, NOW)).toBeNull(); // 記録が無ければ止めない
    recordUsage(ctx.db, info({ five: 0.5 }), NOW);
    expect(quotaBlock(ctx, NOW)).toBeNull();
    recordUsage(ctx.db, info({ five: 0.96 }), NOW);
    expect(quotaBlock(ctx, NOW)).toMatchObject({ until: sec(NOW + 3_600_000) * 1000, window: "five_hour" });
    expect(quotaBlock(ctx, NOW + 3_600_001)).toBeNull();
    // 7日の窓が上限なら、そちらのリセットまで
    recordUsage(ctx.db, info({ five: 0.1, week: 0.99 }), NOW);
    expect(quotaBlock(ctx, NOW)).toMatchObject({ window: "seven_day", until: sec(NOW + 86_400_000 * 3) * 1000 });
    recordUsage(ctx.db, info({ status: "rejected", five: 0.5 }), NOW);
    expect(quotaBlock(ctx, NOW)).toMatchObject({ until: sec(NOW + 3_600_000) * 1000 });
    // 上限は設定で変えられる
    recordUsage(ctx.db, info({ five: 0.85 }), NOW);
    ctx.config.limits.pauseAtUtilization = 0.8;
    expect(quotaBlock(ctx, NOW)).not.toBeNull();
  });

  it("止めている間は run で新しい役割を起動しない。理由を返す", async () => {
    const runner = new ScriptedRunner({ planner: answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false, design: { architect: false, designer: false, reason: "r" } }) });
    const ctx = testContext(runner);
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    recordUsage(ctx.db, info({ five: 0.99, fiveReset: Date.now() + 3_600_000 }), Date.now());
    const r = await runUntilIdle(ctx);
    expect(r.quota?.window).toBe("five_hour");
    expect(runner.calls).toHaveLength(0);
    expect(getTask(ctx.db, t.id)!.state).toBe("queued");
  });

  it("実行中に上限で止まった役割は失敗にせず、タスクを同じ状態のまま残して待つ", async () => {
    const runner = new ScriptedRunner({
      planner: () => ({
        status: "failed",
        error: "Claude AI usage limit reached|1791631800",
        events: [{ kind: "rate_limit", payload: info({ status: "rejected", fiveReset: Date.now() + 3_600_000 }) }],
      }),
    });
    const ctx = testContext(runner);
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    const r = await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("planning");
    expect(r.quota).toBeTruthy();
    expect(listEvents(ctx.db, t.id, 100).some((e) => e.kind === "quota_wait")).toBe(true);
    expect(listEvents(ctx.db, t.id, 100).some((e) => e.kind === "run_failed")).toBe(false);
    expect(listRuns(ctx.db, { taskId: t.id }).at(-1)).toMatchObject({ state: "cancelled" });
  });
});
