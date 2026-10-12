import { describe, expect, it } from "vitest";
import { getProjectSettings, getTask, listEvents, listValidApprovals } from "../src/db/store.ts";
import { runUntilIdle } from "../src/orchestrator/engine.ts";
import { protectPaths, setProjectSettings } from "../src/orchestrator/projects.ts";
import { testContext } from "./helpers/context.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner } from "./helpers/scripted-runner.ts";

type Plan = { size?: string; expectedFiles?: string[]; design?: { architect: boolean; designer: boolean }; testFirstException?: boolean };
const planner = (p: Plan = {}) =>
  answer("plan.md", "ready", {
    acceptanceCriteria: ["a"],
    testFirstException: p.testFirstException ?? false,
    design: { ...(p.design ?? { architect: false, designer: false }), reason: "r" },
    size: p.size ?? "small",
    expectedFiles: p.expectedFiles ?? ["src/items.js", "test/items.test.js"],
  });

async function planned(p: Plan = {}, o: { auto?: boolean; protect?: string[] } = {}) {
  const sent: string[] = [];
  const ctx = testContext(new ScriptedRunner({ planner: planner(p), implementer: () => new Promise(() => {}) }));
  ctx.notifier = (_t, m) => sent.push(m);
  const { project } = await approvedProject(ctx);
  if (o.auto !== false) setProjectSettings(ctx, "shop", { autoApprovePlan: true });
  if (o.protect) protectPaths(ctx, "shop", { add: o.protect });
  const t = newTask(ctx, project.id);
  // 実装者は終わらない台本なので、自動承認されると implementing で止まる(待たずに状態だけ見る)
  void runUntilIdle(ctx);
  await new Promise((r) => setTimeout(r, 300));
  return { ctx, t, sent };
}

describe("小さなタスクの計画の自動承認(8-1)", () => {
  it("プロジェクトでオンにし、条件をすべて満たせば、計画の承認を自動で行う。承認は自動と分かる形で残り、人には通知しない", async () => {
    const { ctx, t, sent } = await planned();
    expect(getTask(ctx.db, t.id)!.state).toBe("implementing");
    expect(listValidApprovals(ctx.db, t.id).find((a) => a.kind === "plan")?.comment).toContain("自動承認");
    expect(listEvents(ctx.db, t.id, 100).some((e) => e.kind === "auto_approved")).toBe(true);
    expect(sent).toEqual([]);
  });

  it("既定はオフ", async () => {
    const { ctx, t } = await planned({}, { auto: false });
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_plan_approval");
  });

  it.each([
    ["規模が small でない", { size: "medium" }, {}],
    ["変更の見込みが4ファイル以上", { expectedFiles: ["a", "b", "c", "d"] }, {}],
    ["変更の見込みが無い", { expectedFiles: [] }, {}],
    ["設計者を動かす", { design: { architect: true, designer: false } }, {}],
    ["デザイナーを動かす", { design: { architect: false, designer: true } }, {}],
    ["テスト先行の例外", { testFirstException: true }, {}],
    ["読ませないパスに触れる", { expectedFiles: ["config/secret.yml"] }, { protect: ["config"] }],
  ])("%s なら人の承認待ちのまま。理由を記録する", async (_name, plan, opts) => {
    const { ctx, t, sent } = await planned(plan as Plan, opts as { protect?: string[] });
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_plan_approval");
    expect(listEvents(ctx.db, t.id, 100).find((e) => e.kind === "auto_approve_skipped")).toBeTruthy();
    expect(sent).toHaveLength(1);
  });

  it("設定は project の settings として残る", async () => {
    const ctx = testContext(new ScriptedRunner({}));
    const { project } = await approvedProject(ctx);
    expect(getProjectSettings(ctx.db, project.id)).toEqual({});
    setProjectSettings(ctx, "shop", { autoApprovePlan: true });
    expect(getProjectSettings(ctx.db, project.id)).toEqual({ autoApprovePlan: true });
  });
});
