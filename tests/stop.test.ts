import { describe, expect, it } from "vitest";
import { getTask, listRuns } from "../src/db/store.ts";
import { latestNeedsInputReason, requestStop, runUntilIdle } from "../src/orchestrator/engine.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { testContext } from "./helpers/context.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { ScriptedRunner } from "./helpers/scripted-runner.ts";

/** 中断の合図が来るまで終わらない役割(実行中の claude の代わり) */
const hangUntilAborted = (spec: RunSpec) =>
  new Promise<{ status: "cancelled"; error: string }>((resolve) => {
    spec.signal!.addEventListener("abort", () => resolve({ status: "cancelled", error: "人が停止しました" }));
  });

describe("停止", () => {
  it("実行中の役割を止め、実行は cancelled、タスクは止まった段で人の判断待ち", async () => {
    const runner = new ScriptedRunner({ planner: hangUntilAborted });
    const ctx = testContext(runner);
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);

    const done = runUntilIdle(ctx);
    await waitFor(() => runner.calls.length === 1);
    expect(runner.calls[0]!.signal).toBeDefined();
    expect(requestStop(ctx, t.id)).toBe(true);
    await done;

    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "planning" });
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("停止");
    expect(listRuns(ctx.db, { taskId: t.id }).map((r) => r.state)).toEqual(["cancelled"]);
  });

  it("このプロセスで動いていないタスクは止められない(false)", async () => {
    const ctx = testContext(new ScriptedRunner({}));
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    expect(requestStop(ctx, t.id)).toBe(false);
  });
});

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error("待ちきれませんでした");
}
