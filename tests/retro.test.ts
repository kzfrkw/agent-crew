import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectProfile, getRepoProfile, getTask, listRepos, listRuns } from "../src/db/store.ts";
import { runUntilIdle } from "../src/orchestrator/engine.ts";
import { approveTask } from "../src/orchestrator/human.ts";
import { projectDir } from "../src/orchestrator/paths.ts";
import { setProjectSettings } from "../src/orchestrator/projects.ts";
import { decideRetro, retroView } from "../src/orchestrator/retro.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { testContext } from "./helpers/context.ts";
import { sh } from "./helpers/gitrepo.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";

const env = (spec: RunSpec) => ({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...spec.extraEnv });
const PROPOSALS = [
  { target: "conventions", text: "API の応答の日付は ISO 8601 で返す" },
  { target: "decisions", text: "在庫の判定は items.js に集める" },
];
const scripts = (over: Record<string, Script> = {}): Record<string, Script> => ({
  planner: answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false, design: { architect: false, designer: false, reason: "r" } }),
  implementer: (spec, n) => {
    writeFileSync(join(spec.cwd, `f${n}.js`), "x");
    sh(spec.cwd, "git", ["add", "."], env(spec));
    sh(spec.cwd, "git", ["commit", "-q", "-m", `feat ${n}`], env(spec));
    writeArtifact(spec, "impl-notes.md", "done");
    return { structuredOutput: { verdict: "done", summary: "s", testCommand: null } };
  },
  verifier: () => ({ structuredOutput: { verdict: "passed", summary: "s" }, bashResults: [{ command: "npm test", isError: false, output: "ok" }] }),
  reviewer: answer("review.md", "approve", { findings: [] }),
  qa: answer("qa-report.md", "passed", { failedCriteria: [] }),
  integrator: answer("pr-draft.md", "done"),
  retrospective: answer("retro.md", "proposed", { proposals: PROPOSALS }),
  ...over,
});

async function done(over: Record<string, Script> = {}, settings: { retrospective?: boolean } = {}) {
  const runner = new ScriptedRunner(scripts(over));
  const ctx = testContext(runner);
  const { project } = await approvedProject(ctx);
  if (settings.retrospective !== undefined) setProjectSettings(ctx, "shop", settings);
  const t = newTask(ctx, project.id);
  await runUntilIdle(ctx);
  approveTask(ctx, t.id, "plan");
  await runUntilIdle(ctx);
  approveTask(ctx, t.id, "final");
  await runUntilIdle(ctx);
  return { ctx, t, runner, project };
}

describe("振り返り(8-5)", () => {
  it("完了したら振り返りを1回だけ動かし、提案を残す。タスクの状態は完了のまま", async () => {
    const { ctx, t, runner } = await done();
    expect(getTask(ctx.db, t.id)!.state).toBe("done");
    expect(runner.calls.filter((c) => c.role === "retrospective")).toHaveLength(1);
    const call = runner.calls.find((c) => c.role === "retrospective")!;
    expect(call.write).toBe("artifacts");
    expect(retroView(ctx.db, t.id)).toEqual({
      proposals: [
        { index: 0, target: "conventions", text: PROPOSALS[0]!.text, status: "pending" },
        { index: 1, target: "decisions", text: PROPOSALS[1]!.text, status: "pending" },
      ],
    });
    await runUntilIdle(ctx);
    expect(runner.calls.filter((c) => c.role === "retrospective")).toHaveLength(1);
  });

  it("採用すると、規約はプロファイルに、判断は decisions.md に、ツールが追記する。却下は記録だけ", async () => {
    const { ctx, t, project } = await done();
    decideRetro(ctx, t.id, 0, true);
    decideRetro(ctx, t.id, 1, false);
    const repo = listRepos(ctx.db, project.id)[0]!;
    expect((getRepoProfile(ctx.db, repo.id) as { conventions: string }).conventions).toContain("API の応答の日付は ISO 8601 で返す");
    expect((getProjectProfile(ctx.db, project.id) as { conventions: string }).conventions).toContain("ISO 8601");
    const decisions = join(projectDir(ctx.home, project.id), "decisions.md");
    expect(existsSync(decisions) ? readFileSync(decisions, "utf8") : "").not.toContain("在庫の判定");
    expect(retroView(ctx.db, t.id)!.proposals.map((p) => p.status)).toEqual(["adopted", "rejected"]);
    expect(() => decideRetro(ctx, t.id, 0, true)).toThrow(/決まって/);
    decideRetro(ctx, t.id, 1, true, { force: true }); // 却下したものを採用し直すことはできる
    expect(readFileSync(decisions, "utf8")).toContain("在庫の判定は items.js に集める");
  });

  it("プロジェクトでオフにすれば動かさない", async () => {
    const { runner } = await done({}, { retrospective: false });
    expect(runner.calls.filter((c) => c.role === "retrospective")).toHaveLength(0);
  });

  it("振り返りが失敗しても、タスクは完了のまま。やり直さない", async () => {
    const { ctx, t, runner } = await done({ retrospective: () => ({ status: "failed", error: "x" }) });
    expect(getTask(ctx.db, t.id)!.state).toBe("done");
    await runUntilIdle(ctx);
    expect(listRuns(ctx.db, { taskId: t.id }).filter((r) => r.role === "retrospective")).toHaveLength(1);
    expect(runner.calls.filter((c) => c.role === "retrospective")).toHaveLength(1);
    expect(retroView(ctx.db, t.id)).toBeNull();
  });
});

describe("振り返りと利用枠(8-5)", () => {
  it("利用枠の上限で止まったら、印を残さずにリセットの後でやり直す", async () => {
    const { recordUsage } = await import("../src/orchestrator/usage.ts");
    const { ctx, t, runner } = await done({ retrospective: () => new Promise(() => {}) as never }, { retrospective: false });
    // 印を付けてから、上限にする
    const { markRetroPending, retroPending } = await import("../src/orchestrator/retro.ts");
    setProjectSettings(ctx, "shop", { retrospective: true });
    markRetroPending(ctx, getTask(ctx.db, t.id)!);
    recordUsage(ctx.db, { status: "rejected", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 1, resetsAt: (Date.now() + 3_600_000) / 1000 } } });
    await runUntilIdle(ctx);
    expect(retroPending(ctx.db, t.id)).toBe(true);
    expect(runner.calls.filter((c) => c.role === "retrospective")).toHaveLength(0);
  });
});
