import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask, listTaskRepos, listValidApprovals } from "../src/db/store.ts";
import { headSha } from "../src/git/worktree.ts";
import { latestNeedsInputReason, runUntilIdle } from "../src/orchestrator/engine.ts";
import { approveTask } from "../src/orchestrator/human.ts";
import { qaPortFor } from "../src/orchestrator/handlers.ts";
import { taskDir } from "../src/orchestrator/paths.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { testContext } from "./helpers/context.ts";
import { sh } from "./helpers/gitrepo.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";

const env = (spec: RunSpec) => ({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...spec.extraEnv });
const scripts: Record<string, Script> = {
  planner: answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false }),
  implementer: (spec, n) => {
    writeFileSync(join(spec.cwd, `f${n}.js`), "x");
    sh(spec.cwd, "git", ["add", "."], env(spec));
    sh(spec.cwd, "git", ["commit", "-q", "-m", `feat ${n}`], env(spec));
    writeArtifact(spec, "impl-notes.md", "done");
    return { structuredOutput: { verdict: "done", summary: "s", testCommand: null } };
  },
  verifier: () => ({ structuredOutput: { verdict: "passed", summary: "s" }, bashResults: [{ command: "npm test", isError: false, output: "ok" }] }),
  reviewer: answer("review.md", "approve"),
};

async function untilQa(qa: Script) {
  const runner = new ScriptedRunner({ ...scripts, qa });
  const ctx = testContext(runner);
  const { project } = await approvedProject(ctx);
  const t = newTask(ctx, project.id);
  await runUntilIdle(ctx);
  approveTask(ctx, t.id, "plan");
  await runUntilIdle(ctx);
  return { ctx, t, runner };
}

describe("QA", () => {
  it("passed なら最終確認待ちへ。QAの合格を HEAD に紐づけて記録する", async () => {
    const { ctx, t, runner } = await untilQa(answer("qa-report.md", "passed"));
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
    const tr = listTaskRepos(ctx.db, t.id)[0]!;
    expect(listValidApprovals(ctx.db, t.id).find((a) => a.kind === "qa")).toMatchObject({ result: "approved", commitSha: headSha(tr.worktreePath, ctx.gitEnv) });
    const call = runner.calls.find((c) => c.role === "qa")!;
    expect(call).toMatchObject({ localServer: true, bashWritesWorktree: true, write: "artifacts" });
    expect(call.prompt).toContain(`PORT=${qaPortFor(t.id)}`);
    expect(call.prompt).toContain(join(taskDir(ctx.home, t.id), "qa-evidence"));
  });

  it("failed なら実装者に差し戻し、実装者は qa-report.md を読む", async () => {
    const { ctx, t, runner } = await untilQa((spec, n) => answer("qa-report.md", n === 0 ? "failed" : "passed")(spec, n));
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "awaiting_final_approval", reviewRounds: 1 });
    expect(runner.calls.filter((c) => c.role === "implementer")[1]!.prompt).toContain("qa-report.md");
  });

  it("QA がコードを変えたら(コミット・追跡ファイルの変更)needs_input", async () => {
    const { ctx, t } = await untilQa((spec, n) => {
      writeFileSync(join(spec.cwd, "README.md"), "changed by qa");
      return answer("qa-report.md", "passed")(spec, n);
    });
    expect(getTask(ctx.db, t.id)!.state).toBe("needs_input");
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("QA");
  });

  it("未追跡のファイル(ビルド結果など)は警告だけで進む", async () => {
    const { ctx, t } = await untilQa((spec, n) => {
      writeFileSync(join(spec.cwd, "server.log"), "log");
      return answer("qa-report.md", "passed")(spec, n);
    });
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
  });

  it("最終確認を承認すると integrating へ。承認はその時点の HEAD に紐づく", async () => {
    const { ctx, t } = await untilQa(answer("qa-report.md", "passed"));
    approveTask(ctx, t.id, "final");
    expect(getTask(ctx.db, t.id)!.state).toBe("integrating");
    const tr = listTaskRepos(ctx.db, t.id)[0]!;
    expect(listValidApprovals(ctx.db, t.id).find((a) => a.kind === "final")!.commitSha).toBe(headSha(tr.worktreePath, ctx.gitEnv));
  });
});
