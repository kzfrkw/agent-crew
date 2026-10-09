import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProject, createTask, listArtifacts, listEvents } from "../src/db/store.ts";
import { invokeRole } from "../src/orchestrator/invoke.ts";
import { answer, ScriptedRunner, writeArtifact } from "./helpers/scripted-runner.ts";
import { testContext } from "./helpers/context.ts";
import { tempDir } from "./helpers/gitrepo.ts";

function setup(runner: ScriptedRunner) {
  const ctx = testContext(runner);
  const p = createProject(ctx.db, { name: "p" });
  const t = createTask(ctx.db, { projectId: p.id, title: "t", body: "b" });
  const cwd = tempDir("agent-crew-cwd-");
  const artifactsDir = join(ctx.home, "tasks", String(t.id));
  return { ctx, t, cwd, artifactsDir };
}

const runRow = (ctx: ReturnType<typeof setup>["ctx"], id: number) =>
  ctx.db.prepare("SELECT state, verdict, summary, error, cost_usd FROM runs WHERE id = ?").get(id);

describe("invokeRole", () => {
  it("成功: 実行を記録し、成果物を登録し、イベントを保存する", async () => {
    const runner = new ScriptedRunner({ planner: answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false }) });
    const { ctx, t, cwd, artifactsDir } = setup(runner);
    const r = await invokeRole(ctx, { roleName: "planner", taskId: t.id, cwd, artifactsDir, prompt: "計画して" });
    expect(r).toMatchObject({ ok: true, verdict: "ready", extra: { acceptanceCriteria: ["a"] } });
    expect(runRow(ctx, r.runId)).toMatchObject({ state: "succeeded", verdict: "ready", cost_usd: 0.01 });
    expect(listArtifacts(ctx.db, t.id)).toMatchObject([{ kind: "plan", verdict: "ready", path: join(artifactsDir, "plan.md") }]);
    expect(listEvents(ctx.db, t.id).map((e) => e.kind)).toContain("init");
    expect(existsSync(join(ctx.home, "runs", String(r.runId), "plan.md"))).toBe(true); // スナップショット
  });

  it("役割定義の値(モデル・道具・書き込み範囲・スキーマ)でランナーを呼ぶ", async () => {
    const runner = new ScriptedRunner({ reviewer: answer("review.md", "approve", { findings: [] }) });
    const { ctx, t, cwd, artifactsDir } = setup(runner);
    await invokeRole(ctx, { roleName: "reviewer", taskId: t.id, cwd, artifactsDir, prompt: "x" });
    expect(runner.calls[0]).toMatchObject({ role: "reviewer", model: "opus", write: "artifacts", cwd, artifactsDir });
    expect((runner.calls[0]!.jsonSchema as any).properties.verdict.enum).toContain("changes_requested");
    expect(runner.calls[0]!.systemPromptAppend).toContain("レビュワー");
  });

  it("成果物が無ければ失敗", async () => {
    const runner = new ScriptedRunner({ planner: () => ({ structuredOutput: { verdict: "ready", summary: "s", acceptanceCriteria: [], testFirstException: false } }) });
    const { ctx, t, cwd, artifactsDir } = setup(runner);
    const r = await invokeRole(ctx, { roleName: "planner", taskId: t.id, cwd, artifactsDir, prompt: "x" });
    expect(r).toMatchObject({ ok: false, failure: "error", reason: expect.stringContaining("plan.md") });
    expect(runRow(ctx, r.runId)).toMatchObject({ state: "failed" });
  });

  it("成果物の判定と最終応答の判定が違えば失敗", async () => {
    const runner = new ScriptedRunner({
      reviewer: (spec) => {
        writeArtifact(spec, "review.md", "changes_requested");
        return { structuredOutput: { verdict: "approve", summary: "s", findings: [] } };
      },
    });
    const { ctx, t, cwd, artifactsDir } = setup(runner);
    const r = await invokeRole(ctx, { roleName: "reviewer", taskId: t.id, cwd, artifactsDir, prompt: "x" });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("一致しません") });
  });

  it("前回の成果物が残っていても、今回書かれていなければ失敗(古い成果物を使わない)", async () => {
    const runner = new ScriptedRunner({ reviewer: () => ({ structuredOutput: { verdict: "approve", summary: "s", findings: [] } }) });
    const { ctx, t, cwd, artifactsDir } = setup(runner);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "review.md"), "---\nverdict: approve\n---\n古い\n");
    const r = await invokeRole(ctx, { roleName: "reviewer", taskId: t.id, cwd, artifactsDir, prompt: "x" });
    expect(r.ok).toBe(false);
  });

  it("判定がスキーマに合わなければ失敗", async () => {
    const runner = new ScriptedRunner({ reviewer: answer("review.md", "lgtm") });
    const { ctx, t, cwd, artifactsDir } = setup(runner);
    const r = await invokeRole(ctx, { roleName: "reviewer", taskId: t.id, cwd, artifactsDir, prompt: "x" });
    expect(r.ok).toBe(false);
  });

  it("時間・予算の上限は failure=limit", async () => {
    const runner = new ScriptedRunner({
      planner: () => ({ status: "timeout", error: "時間の上限" }),
      reviewer: () => ({ status: "failed", error: "claude がエラーで終了しました(error_max_budget_usd)" }),
    });
    const { ctx, t, cwd, artifactsDir } = setup(runner);
    expect(await invokeRole(ctx, { roleName: "planner", taskId: t.id, cwd, artifactsDir, prompt: "x" })).toMatchObject({ ok: false, failure: "limit" });
    expect(await invokeRole(ctx, { roleName: "reviewer", taskId: t.id, cwd, artifactsDir, prompt: "x" })).toMatchObject({ ok: false, failure: "limit" });
  });
});
