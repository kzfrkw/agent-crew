import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask, listChildren, listTaskRepos } from "../src/db/store.ts";
import { runUntilIdle } from "../src/orchestrator/engine.ts";
import { approveTask, cancelTask } from "../src/orchestrator/human.ts";
import { nextActions } from "../src/orchestrator/next-actions.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { testContext } from "./helpers/context.ts";
import { git, sh } from "./helpers/gitrepo.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";

const env = (spec: RunSpec) => ({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...spec.extraEnv });
const SPLIT = [
  { title: "注文に状態を持たせる", body: "API に status を足す" },
  { title: "一覧に状態を表示する", body: "画面に状態の列を足す" },
];
const plannerScript: Script = (spec, n) => {
  // 親の計画は分割を提案し、子の計画は小さく返す
  const isParent = spec.prompt.includes("大きなチケット");
  return answer("plan.md", "ready", {
    acceptanceCriteria: ["a"],
    testFirstException: false,
    design: { architect: false, designer: false, reason: "r" },
    size: isParent ? "large" : "small",
    expectedFiles: ["a.js"],
    split: isParent ? SPLIT : [],
  })(spec, n);
};
const scripts: Record<string, Script> = {
  planner: plannerScript,
  implementer: (spec) => {
    const name = `f-${Date.now()}-${Math.random().toString(36).slice(2)}.js`;
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

async function planned() {
  const runner = new ScriptedRunner(scripts);
  const ctx = testContext(runner);
  const { project, repo } = await approvedProject(ctx);
  const t = newTask(ctx, project.id, "注文の状態(大きなチケット)", "大きなチケット: API と画面の両方");
  await runUntilIdle(ctx);
  return { ctx, t, runner, repo };
}

/** 承認待ちの子を、完了まで進める */
async function finishChild(ctx: ReturnType<typeof testContext>, id: number) {
  await runUntilIdle(ctx);
  approveTask(ctx, id, "plan");
  await runUntilIdle(ctx);
  approveTask(ctx, id, "final");
  await runUntilIdle(ctx);
}

describe("チケットの分割(8-2)", () => {
  it("プランナーが分割を提案したら、計画の承認に「分割して進める」が出る", async () => {
    const { ctx, t } = await planned();
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_plan_approval");
    const approve = nextActions(ctx.db, getTask(ctx.db, t.id)!).find((a) => a.kind === "approve");
    expect(approve?.split).toEqual({ count: 2, titles: SPLIT.map((s) => s.title) });
  });

  it("分割して承認すると子タスクを作り、親は分割済みで待つ。子は順に進み、2つ目は1つ目のブランチをベースにする。全部終われば親も完了", async () => {
    const { ctx, t, repo } = await planned();
    approveTask(ctx, t.id, "plan", undefined, undefined, { split: true });
    expect(getTask(ctx.db, t.id)!.state).toBe("split");
    const kids = listChildren(ctx.db, t.id);
    expect(kids.map((k) => [k.title, k.seq, k.parentId])).toEqual([
      ["注文に状態を持たせる", 1, t.id],
      ["一覧に状態を表示する", 2, t.id],
    ]);
    expect(kids[0]!.body).toContain("API に status を足す");
    expect(kids[0]!.body).toContain(`#${t.id}`);

    // 1つ目が終わるまで、2つ目は始まらない
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, kids[1]!.id)!.state).toBe("queued");
    await finishChild(ctx, kids[0]!.id);
    expect(getTask(ctx.db, kids[0]!.id)!.state).toBe("done");

    await finishChild(ctx, kids[1]!.id);
    expect(getTask(ctx.db, kids[1]!.id)!.state).toBe("done");
    // 2つ目のブランチは1つ目のコミットを含む
    const first = listTaskRepos(ctx.db, kids[0]!.id)[0]!.branchName;
    const second = listTaskRepos(ctx.db, kids[1]!.id)[0]!.branchName;
    expect(git(repo, "merge-base", "--is-ancestor", first, second)).toBe("");
    expect(getTask(ctx.db, t.id)!.state).toBe("done");
  });

  it("分割せずに承認すれば従来どおり", async () => {
    const { ctx, t } = await planned();
    approveTask(ctx, t.id, "plan");
    expect(getTask(ctx.db, t.id)!.state).toBe("implementing");
    expect(listChildren(ctx.db, t.id)).toEqual([]);
  });

  it("子を取り消したら、親は人の回答待ちになる", async () => {
    const { ctx, t } = await planned();
    approveTask(ctx, t.id, "plan", undefined, undefined, { split: true });
    cancelTask(ctx, listChildren(ctx.db, t.id)[0]!.id);
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "split" });
  });

  it("分割の案が無ければ、分割して承認できない", async () => {
    const ctx = testContext(new ScriptedRunner({ ...scripts, planner: answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false, design: { architect: false, designer: false, reason: "r" } }) }));
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    await runUntilIdle(ctx);
    expect(() => approveTask(ctx, t.id, "plan", undefined, undefined, { split: true })).toThrow(/分割の案/);
  });
});
