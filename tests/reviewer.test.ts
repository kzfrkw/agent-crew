import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask, listTaskRepos, listValidApprovals } from "../src/db/store.ts";
import { headSha } from "../src/git/worktree.ts";
import { latestNeedsInputReason, runUntilIdle } from "../src/orchestrator/engine.ts";
import { approveTask } from "../src/orchestrator/human.ts";
import { taskDir } from "../src/orchestrator/paths.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { testContext } from "./helpers/context.ts";
import { sh } from "./helpers/gitrepo.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";

const planner = answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false });
const implementer: Script = (spec: RunSpec, n) => {
  writeFileSync(join(spec.cwd, `feature${n}.js`), `export const f = ${n};\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...spec.extraEnv };
  sh(spec.cwd, "git", ["add", "."], env);
  sh(spec.cwd, "git", ["commit", "-q", "-m", `feat ${n}`], env);
  writeArtifact(spec, "impl-notes.md", "done");
  return { structuredOutput: { verdict: "done", summary: "s", testCommand: null } };
};
const verifier = (pass: boolean): Script => () => ({
  structuredOutput: { verdict: pass ? "passed" : "failed", summary: "s" },
  bashResults: [{ command: "npm test", isError: !pass, output: pass ? "ok" : "fail" }],
});

async function implemented(scripts: Record<string, Script>) {
  const runner = new ScriptedRunner({ planner, implementer, verifier: verifier(true), qa: answer("qa-report.md", "passed"), ...scripts });
  const ctx = testContext(runner);
  const { project } = await approvedProject(ctx);
  const t = newTask(ctx, project.id);
  await runUntilIdle(ctx);
  approveTask(ctx, t.id, "plan");
  await runUntilIdle(ctx);
  return { ctx, t, runner };
}

describe("レビュワー", () => {
  it("テストの再実行が通ったらレビューし、approve で QA へ進む。承認は HEAD に紐づく", async () => {
    const { ctx, t, runner } = await implemented({ reviewer: answer("review.md", "approve") });
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
    expect(runner.rolesCalled()).toEqual(["planner", "implementer", "verifier", "reviewer", "qa"]);
    const tr = listTaskRepos(ctx.db, t.id)[0]!;
    const review = listValidApprovals(ctx.db, t.id).find((a) => a.kind === "review")!;
    expect(review).toMatchObject({ result: "approved", commitSha: headSha(tr.worktreePath, ctx.gitEnv), repoId: tr.repoId });
    const dir = taskDir(ctx.home, t.id);
    expect(readFileSync(join(dir, "diff.patch"), "utf8")).toContain("feature0.js");
    expect(existsSync(join(dir, "test-changes.md"))).toBe(true);
    const call = runner.calls.find((c) => c.role === "reviewer")!;
    expect(call.prompt).toContain("diff.patch");
    expect(call.prompt).toContain("test-changes.md");
    expect(call.write).toBe("artifacts");
  });

  it("テストの再実行が失敗したら、レビューせずに実装者へ差し戻す", async () => {
    const { ctx, t, runner } = await implemented({ verifier: verifier(false), reviewer: answer("review.md", "approve") });
    // 差し戻し → 実装 → 再実行失敗 … を上限まで繰り返して needs_input
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "implementing" });
    expect(runner.rolesCalled()).not.toContain("reviewer");
    expect(runner.rolesCalled().filter((r) => r === "implementer")).toHaveLength(4);
    expect(latestNeedsInputReason(ctx.db, t.id)).toBeDefined();
  });

  it("changes_requested で実装者に戻り、実装者は review.md を読む", async () => {
    const { ctx, t, runner } = await implemented({
      reviewer: (spec, n) => answer("review.md", n === 0 ? "changes_requested" : "approve")(spec, n),
    });
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "awaiting_final_approval", reviewRounds: 1 });
    const second = runner.calls.filter((c) => c.role === "implementer")[1]!;
    expect(second.prompt).toContain("review.md");
    expect(second.prompt).toContain("差し戻しの回数: 1");
  });

  it("人のコミットが含まれていれば、レビュワーに伝える", async () => {
    const { ctx, t, runner } = await implemented({
      verifier: verifier(true),
      reviewer: (spec, n) => {
        if (n === 0) {
          // 1回目のレビューの前に、人が同じブランチにコミットした状況を作る
          writeFileSync(join(spec.cwd, "by-human.js"), "x");
          sh(spec.cwd, "git", ["add", "."], { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Human", GIT_AUTHOR_EMAIL: "h@x", GIT_COMMITTER_NAME: "Human", GIT_COMMITTER_EMAIL: "h@x" });
          sh(spec.cwd, "git", ["commit", "-q", "-m", "fix by human"], { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Human", GIT_AUTHOR_EMAIL: "h@x", GIT_COMMITTER_NAME: "Human", GIT_COMMITTER_EMAIL: "h@x" });
          return answer("review.md", "changes_requested")(spec, n);
        }
        return answer("review.md", "approve")(spec, n);
      },
    });
    const secondReview = runner.calls.filter((c) => c.role === "reviewer")[1]!;
    expect(secondReview.prompt).toContain("fix by human");
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
  });
});
