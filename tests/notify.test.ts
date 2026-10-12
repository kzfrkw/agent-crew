import { describe, expect, it } from "vitest";
import { runUntilIdle } from "../src/orchestrator/engine.ts";
import { osascriptArgs } from "../src/orchestrator/notify.ts";
import { testContext } from "./helpers/context.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner } from "./helpers/scripted-runner.ts";

const plannerReady = answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false, design: { architect: false, designer: false, reason: "r" } });

describe("人の対応待ちの通知(7-3)", () => {
  it("タスクが人の対応待ちになったら、番号・状態・タイトルを通知する", async () => {
    const ctx = testContext(new ScriptedRunner({ planner: plannerReady }));
    const sent: { title: string; message: string }[] = [];
    ctx.notifier = (title, message) => sent.push({ title, message });
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id, "在庫0を除外");
    await runUntilIdle(ctx);
    expect(sent).toEqual([{ title: "agent-crew", message: `#${t.id} 計画の承認待ち: 在庫0を除外` }]);
  });

  it("config の notify が false なら通知しない", async () => {
    const ctx = testContext(new ScriptedRunner({ planner: plannerReady }));
    const sent: string[] = [];
    ctx.notifier = (_t, m) => sent.push(m);
    ctx.config.notify = false;
    const { project } = await approvedProject(ctx);
    newTask(ctx, project.id);
    await runUntilIdle(ctx);
    expect(sent).toEqual([]);
  });

  it("文面は AppleScript に埋め込まず、引数で渡す(タイトルに引用符や改行があっても壊れない)", () => {
    const args = osascriptArgs("agent-crew", '#1 計画の承認待ち: "; do shell script "rm -rf ~"');
    expect(args.slice(0, -2).join(" ")).not.toContain("rm -rf");
    expect(args.at(-1)).toBe('#1 計画の承認待ち: "; do shell script "rm -rf ~"');
    expect(args).toContain("--");
  });
});
