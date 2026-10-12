import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask } from "../src/db/store.ts";
import { latestNeedsInputReason, runUntilIdle } from "../src/orchestrator/engine.ts";
import { approveTask } from "../src/orchestrator/human.ts";
import { testFailureKey } from "../src/orchestrator/bounce.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { testContext } from "./helpers/context.ts";
import { sh } from "./helpers/gitrepo.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";

const env = (spec: RunSpec) => ({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...spec.extraEnv });
const scripts = (over: Record<string, Script>): Record<string, Script> => ({
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
  ...over,
});

async function run(over: Record<string, Script>) {
  const runner = new ScriptedRunner(scripts(over));
  const ctx = testContext(runner, { limits: { maxReviewRounds: 5 } as never });
  const { project } = await approvedProject(ctx);
  const t = newTask(ctx, project.id);
  await runUntilIdle(ctx);
  approveTask(ctx, t.id, "plan");
  await runUntilIdle(ctx);
  return { ctx, t, runner };
}

const failing = (output: string) => ({ structuredOutput: { verdict: "failed", summary: "s" }, bashResults: [{ command: "npm test", isError: true, output }] });
const must = (title: string, repeated: boolean) => ({ severity: "must", file: "a.js", line: 1, title, detail: "d", suggestion: "s", repeated });

describe("同じ失敗の繰り返しの検出(8-3)", () => {
  it("テストの失敗の要点は、時間や回数の数字が変わっても同じになる。失敗したテストが違えば変わる", () => {
    const a = "✓ ok 1 (3ms)\n× 在庫0を返さない 12ms\nTests 1 failed | 4 passed (5)\nDuration 1.2s";
    const b = "✓ ok 1 (9ms)\n× 在庫0を返さない 30ms\nTests 1 failed | 4 passed (5)\nDuration 3.4s";
    const c = "× 一覧が空 2ms\nTests 1 failed";
    expect(testFailureKey(a)).toBe(testFailureKey(b));
    expect(testFailureKey(a)).not.toBe(testFailureKey(c));
    expect(testFailureKey("")).toBe("");
  });

  it("テストの再実行が同じ失敗で2回続いたら、上限を待たずに人の回答待ちにする", async () => {
    const { ctx, t, runner } = await run({ verifier: () => failing("× 在庫0を返さない 12ms\n1 failed") });
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "implementing" });
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("同じ理由で2回");
    expect(runner.calls.filter((c) => c.role === "implementer")).toHaveLength(2);
    // 2回目の実装者には、直近の差し戻しの理由を強調して渡す
    expect(runner.calls.filter((c) => c.role === "implementer")[1]!.prompt).toContain("直近の差し戻しの理由");
  });

  it("失敗が変われば、従来どおり差し戻しを続ける", async () => {
    let n = 0;
    const { ctx, t, runner } = await run({ verifier: () => (n++ < 2 ? failing(`× ${["在庫が負になる", "一覧が空"][n - 1]} 1ms`) : { structuredOutput: { verdict: "passed", summary: "s" }, bashResults: [{ command: "npm test", isError: false, output: "ok" }] }) });
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
    expect(runner.calls.filter((c) => c.role === "implementer")).toHaveLength(3);
  });

  it("レビュワーが「前回と同じ指摘」(repeated)の Must を出したら、人の回答待ちにする", async () => {
    const { ctx, t } = await run({
      reviewer: (spec, n) => answer("review.md", "changes_requested", { findings: [must("在庫の判定が逆", n > 0)] })(spec, n),
      auditor: answer("audit.md", "upheld", { judgments: [{ finding: 0, result: "valid", evidence: "r" }] }),
    });
    expect(getTask(ctx.db, t.id)!.state).toBe("needs_input");
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("同じ理由で2回");
  });

  it("QA が同じ受け入れ条件で2回不合格にしたら、人の回答待ちにする", async () => {
    const { ctx, t } = await run({ qa: answer("qa-report.md", "failed", { failedCriteria: ["在庫0を返さない"] }) });
    expect(getTask(ctx.db, t.id)!.state).toBe("needs_input");
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("在庫0を返さない");
  });
});
