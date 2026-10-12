import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getTask, listRuns, startRun } from "../src/db/store.ts";
import { approveTask } from "../src/orchestrator/human.ts";
import { Worker } from "../src/orchestrator/worker.ts";
import { recordUsage } from "../src/orchestrator/usage.ts";
import { queryEvents } from "../src/db/store.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { testContext } from "./helpers/context.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner } from "./helpers/scripted-runner.ts";

const plannerReady = answer("plan.md", "ready", { acceptanceCriteria: ["在庫0を返さない"], testFirstException: false, design: { architect: false, designer: false, reason: "小さな変更" } });

/** 中断の合図が来るまで終わらない役割(実行中の claude の代わり) */
const untilAborted = (spec: RunSpec) =>
  new Promise<{ status: "cancelled"; error: string }>((resolve) => spec.signal!.addEventListener("abort", () => resolve({ status: "cancelled", error: "停止" })));

let worker: Worker | undefined;
afterEach(async () => {
  await worker?.close();
  worker = undefined;
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("待ちきれませんでした");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("常駐ワーカー", () => {
  it("ロックを取り、進められるタスクを自動で進める。人の操作の後は kick ですぐ動く", async () => {
    const runner = new ScriptedRunner({ planner: plannerReady, implementer: untilAborted });
    const ctx = testContext(runner);
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);

    worker = new Worker(ctx, { pollMs: 10_000 });
    worker.start();
    expect(worker.status().state).toBe("running");
    expect(existsSync(join(ctx.home, "run.lock"))).toBe(true);
    await waitFor(() => getTask(ctx.db, t.id)!.state === "awaiting_plan_approval");

    approveTask(ctx, t.id, "plan");
    worker.kick();
    await waitFor(() => runner.rolesCalled().includes("implementer"));
    expect(worker.status().active).toEqual([t.id]);
  });

  it("一定間隔で見直し、ほかのプロセスが作ったタスクも拾う", async () => {
    const runner = new ScriptedRunner({ planner: plannerReady });
    const ctx = testContext(runner);
    const { project } = await approvedProject(ctx);
    worker = new Worker(ctx, { pollMs: 30 });
    worker.start();
    await new Promise((r) => setTimeout(r, 50));
    const t = newTask(ctx, project.id);
    await waitFor(() => getTask(ctx.db, t.id)!.state === "awaiting_plan_approval");
  });

  it("CLI の run がロックを持っていれば locked。外れたら取り直して動く", async () => {
    const ctx = testContext(new ScriptedRunner({ planner: plannerReady }));
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    const lock = join(ctx.home, "run.lock");
    writeFileSync(lock, String(process.pid)); // 生きているプロセスが持っているロック

    worker = new Worker(ctx, { pollMs: 30 });
    worker.start();
    expect(worker.status().state).toBe("locked");
    await new Promise((r) => setTimeout(r, 80));
    expect(getTask(ctx.db, t.id)!.state).toBe("queued");

    const { rmSync } = await import("node:fs");
    rmSync(lock);
    await waitFor(() => getTask(ctx.db, t.id)!.state === "awaiting_plan_approval");
    expect(worker.status().state).toBe("running");
  });

  it("一時停止中は新しい役割を起動せず、ロックを外す。再開で動く", async () => {
    const ctx = testContext(new ScriptedRunner({ planner: plannerReady }));
    const { project } = await approvedProject(ctx);
    worker = new Worker(ctx, { pollMs: 30 });
    worker.start();
    await worker.pause();
    expect(worker.status().state).toBe("paused");
    expect(existsSync(join(ctx.home, "run.lock"))).toBe(false);

    const t = newTask(ctx, project.id);
    await new Promise((r) => setTimeout(r, 80));
    expect(getTask(ctx.db, t.id)!.state).toBe("queued");

    worker.resume();
    expect(worker.status().state).toBe("running");
    await waitFor(() => getTask(ctx.db, t.id)!.state === "awaiting_plan_approval");
  });

  it("一時停止しても、実行中の役割は最後まで動かす", async () => {
    let finish: () => void = () => {};
    const runner = new ScriptedRunner({
      planner: async (spec: RunSpec) => {
        await new Promise<void>((r) => (finish = r));
        return plannerReady(spec, 0);
      },
    });
    const ctx = testContext(runner);
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    worker = new Worker(ctx, { pollMs: 30 });
    worker.start();
    await waitFor(() => runner.calls.length === 1);
    const paused = worker.pause();
    expect(worker.status().state).toBe("paused");
    finish();
    await paused;
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_plan_approval");
    expect(existsSync(join(ctx.home, "run.lock"))).toBe(false);
  });

  it("起動時に、前回中断されて running のまま残った実行を失敗として記録する", async () => {
    const ctx = testContext(new ScriptedRunner({}));
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    startRun(ctx.db, { taskId: t.id, role: "planner" });
    worker = new Worker(ctx, { pollMs: 1000 });
    worker.start();
    expect(listRuns(ctx.db, { taskId: t.id }).map((r) => r.state)).toEqual(["failed"]);
  });

  it("close で実行中の役割を止め、ロックを外す", async () => {
    const runner = new ScriptedRunner({
      planner: untilAborted,
    });
    const ctx = testContext(runner);
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    worker = new Worker(ctx, { pollMs: 1000 });
    worker.start();
    await waitFor(() => runner.calls.length === 1);
    await worker.close();
    worker = undefined;
    expect(getTask(ctx.db, t.id)!.state).toBe("needs_input");
    expect(existsSync(join(ctx.home, "run.lock"))).toBe(false);
  });

  it("利用枠の上限の間は新しい役割を起動せず、状態に理由と再開の時刻を出す。リセットの時刻を過ぎたら自動で動く(7-1)", async () => {
    const runner = new ScriptedRunner({ planner: plannerReady });
    const ctx = testContext(runner);
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    const reset = Date.now() + 400;
    recordUsage(ctx.db, { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.97, resetsAt: reset / 1000 } } });
    worker = new Worker(ctx, { pollMs: 30 });
    worker.start();
    await new Promise((r) => setTimeout(r, 150));
    expect(runner.calls).toHaveLength(0);
    expect(worker.status().quota).toMatchObject({ window: "five_hour" });
    expect(queryEvents(ctx.db, { limit: 100 }).filter((e) => e.kind === "quota_paused")).toHaveLength(1); // 何度も記録しない
    await waitFor(() => getTask(ctx.db, t.id)!.state === "awaiting_plan_approval", 3000);
    expect(worker.status().quota).toBeUndefined();
  });
});
