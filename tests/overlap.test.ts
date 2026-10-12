import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask, listEvents } from "../src/db/store.ts";
import { runUntilIdle } from "../src/orchestrator/engine.ts";
import { approveTask } from "../src/orchestrator/human.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { testContext } from "./helpers/context.ts";
import { sh } from "./helpers/gitrepo.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";

const env = (spec: RunSpec) => ({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...spec.extraEnv });
const files: Record<string, string[]> = { 在庫: ["src/items.js", "test/items.test.js"], 検索: ["src/items.js", "src/search.js"], 画面: ["web/app.js"] };
const scripts: Record<string, Script> = {
  planner: (spec, n) => {
    const key = Object.keys(files).find((k) => spec.prompt.includes(`# タスク #`) && spec.prompt.split("\n")[0]!.includes(k))!;
    return answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false, design: { architect: false, designer: false, reason: "r" }, size: "medium", expectedFiles: files[key] })(spec, n);
  },
  implementer: (spec) => {
    const name = `f-${Math.random().toString(36).slice(2)}.js`;
    writeFileSync(join(spec.cwd, name), "x");
    sh(spec.cwd, "git", ["add", "."], env(spec));
    sh(spec.cwd, "git", ["commit", "-q", "-m", `feat ${name}`], env(spec));
    writeArtifact(spec, "impl-notes.md", "done");
    return { structuredOutput: { verdict: "done", summary: "s", testCommand: null } };
  },
  verifier: () => ({ structuredOutput: { verdict: "passed", summary: "s" }, bashResults: [{ command: "npm test", isError: false, output: "ok" }] }),
  reviewer: answer("review.md", "approve", { findings: [] }),
  qa: answer("qa-report.md", "passed", { failedCriteria: [] }),
  integrator: answer("pr-draft.md", "done"),
};

describe("同時実行 2 での変更の重なり(8-4)", () => {
  it("変更の見込みのファイルが重なるタスクは、先のタスクが終わる(統合まで)まで実装を始めない。重ならなければ並んで進む", async () => {
    const runner = new ScriptedRunner(scripts);
    const ctx = testContext(runner, { concurrency: 2 });
    const { project } = await approvedProject(ctx);
    const a = newTask(ctx, project.id, "在庫0を除外");
    const b = newTask(ctx, project.id, "検索を追加");
    const c = newTask(ctx, project.id, "画面を整える");
    await runUntilIdle(ctx);
    for (const t of [a, b, c]) approveTask(ctx, t.id, "plan");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, a.id)!.state).toBe("awaiting_final_approval");
    expect(getTask(ctx.db, c.id)!.state).toBe("awaiting_final_approval"); // 重ならない
    expect(getTask(ctx.db, b.id)!.state).toBe("implementing"); // a と src/items.js が重なるので待つ
    expect(runner.calls.filter((x) => x.role === "implementer")).toHaveLength(2);
    const waits = listEvents(ctx.db, b.id, 100).filter((e) => e.kind === "waiting_overlap");
    expect(waits).toHaveLength(1); // 何度も記録しない
    expect(String((waits[0]!.payload as { reason: string }).reason)).toContain(`#${a.id}`);

    approveTask(ctx, a.id, "final");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, a.id)!.state).toBe("done");
    expect(getTask(ctx.db, b.id)!.state).toBe("awaiting_final_approval");
  });
});

describe("アプリを起動する段の順番(8-4)", () => {
  it("同じプロジェクトでは、確認 URL のポートでアプリを起動する段(デザインレビューの撮影、複数リポジトリの QA)を1つずつ進める", async () => {
    const { appStageBusy } = await import("../src/orchestrator/overlap.ts");
    const { createTask, startRun, updateTaskState } = await import("../src/db/store.ts");
    const ctx = testContext(new ScriptedRunner({}));
    const { project } = await approvedProject(ctx);
    const a = createTask(ctx.db, { projectId: project.id, title: "a", body: "" });
    const b = createTask(ctx.db, { projectId: project.id, title: "b", body: "" });
    updateTaskState(ctx.db, a.id, { state: "design_reviewing" });
    updateTaskState(ctx.db, b.id, { state: "design_reviewing" });
    expect(appStageBusy(ctx.db, getTask(ctx.db, b.id)!)).toBe(false);
    // 撮影中(役割の実行の前)も、進めている最中のタスクとしてぶつかる
    expect(appStageBusy(ctx.db, getTask(ctx.db, b.id)!, [a.id])).toBe(true);
    startRun(ctx.db, { taskId: a.id, role: "design_reviewer" });
    expect(appStageBusy(ctx.db, getTask(ctx.db, b.id)!)).toBe(true);
    // 1リポジトリの QA はタスクごとのポートを使うので、並んで進める
    updateTaskState(ctx.db, a.id, { state: "qa" });
    updateTaskState(ctx.db, b.id, { state: "qa" });
    startRun(ctx.db, { taskId: a.id, role: "qa" });
    expect(appStageBusy(ctx.db, getTask(ctx.db, b.id)!)).toBe(false);
  });
});
