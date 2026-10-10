import { describe, expect, it } from "vitest";
import { createTask, getProjectByName, getTask, listRepos, listTaskRepos } from "../src/db/store.ts";
import { latestNeedsInputReason, runUntilIdle } from "../src/orchestrator/engine.ts";
import { approveTask } from "../src/orchestrator/human.ts";
import { taskDir } from "../src/orchestrator/paths.ts";
import { addRepository, approveProfile, registerProject } from "../src/orchestrator/projects.ts";
import { testContext } from "./helpers/context.ts";
import { git, makeRepo } from "./helpers/gitrepo.ts";
import { PROFILE } from "./helpers/project.ts";
import { answer, ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";

const profiler: Script = (spec) => {
  writeArtifact(spec, "profile.md", "ready");
  return { structuredOutput: { verdict: "ready", summary: "s", profile: PROFILE } };
};
const planner = (repos: string[] | undefined, design = { architect: false, designer: false }): Script =>
  answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false, design: { ...design, reason: "r" }, ...(repos ? { repos } : {}) });

async function multiProject(plannerScript: Script) {
  const runner = new ScriptedRunner({ profiler, planner: plannerScript });
  const ctx = testContext(runner);
  await registerProject(ctx, { name: "shop", repoPath: makeRepo().repo, role: "frontend" });
  await addRepository(ctx, { name: "shop", repoPath: makeRepo().repo, role: "backend" });
  approveProfile(ctx, "shop");
  const project = getProjectByName(ctx.db, "shop")!;
  const t = createTask(ctx.db, { projectId: project.id, title: "注文履歴の画面と API", body: "両方にまたがる" });
  return { ctx, runner, project, t };
}

describe("複数リポジトリのタスク(フェーズ5)", () => {
  it("worktree を作らずに計画する。プランナーは各リポジトリの本体を読む(作業場所は成果物ディレクトリ)", async () => {
    const { ctx, runner, project, t } = await multiProject(planner(["backend", "frontend"], { architect: true, designer: false }));
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_plan_approval");
    expect(listTaskRepos(ctx.db, t.id)).toEqual([]);
    const call = runner.calls.find((c) => c.role === "planner")!;
    expect(call.cwd).toBe(taskDir(ctx.home, t.id));
    for (const r of listRepos(ctx.db, project.id)) expect(call.prompt).toContain(r.path);
    expect(getTask(ctx.db, t.id)!.repos).toEqual(["backend", "frontend"]);
  });

  it("計画の承認で、選ばれたリポジトリだけ worktree を作る(ブランチ名は共通)。2つ以上なら設計者は必須", async () => {
    const { ctx, t } = await multiProject(planner(["backend", "frontend"]));
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "plan", undefined, { architect: false, designer: false });
    const trs = listTaskRepos(ctx.db, t.id);
    expect(trs).toHaveLength(2);
    expect(new Set(trs.map((x) => x.branchName)).size).toBe(1);
    for (const tr of trs) expect(git(tr.worktreePath, "branch", "--show-current")).toBe(tr.branchName);
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "designing", design: { architect: true } });
  });

  it("片方だけで済むなら、そのリポジトリだけで進む(設計者は必須にしない)", async () => {
    const { ctx, project, t } = await multiProject(planner(["frontend"]));
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "plan");
    const trs = listTaskRepos(ctx.db, t.id);
    const front = listRepos(ctx.db, project.id).find((r) => r.role === "frontend")!;
    expect(trs.map((x) => x.repoId)).toEqual([front.id]);
    expect(getTask(ctx.db, t.id)!.state).toBe("implementing");
  });

  it("プランナーが変更するリポジトリを返さない・知らない役目を返したら、人の判断待ち", async () => {
    const a = await multiProject(planner(undefined));
    await runUntilIdle(a.ctx);
    expect(getTask(a.ctx.db, a.t.id)!.state).toBe("needs_input");
    expect(latestNeedsInputReason(a.ctx.db, a.t.id)).toContain("repos");
    const b = await multiProject(planner(["db"]));
    await runUntilIdle(b.ctx);
    expect(latestNeedsInputReason(b.ctx.db, b.t.id)).toContain("db");
  });
});
