import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask, listEvents, listTaskRepos, setProjectSettingsRow } from "../src/db/store.ts";
import { latestNeedsInputReason, runUntilIdle } from "../src/orchestrator/engine.ts";
import { approveTask } from "../src/orchestrator/human.ts";
import { nextActions } from "../src/orchestrator/next-actions.ts";
import type { Config } from "../src/config/config.ts";
import { testContext } from "./helpers/context.ts";
import { devScripts } from "./helpers/dev-scripts.ts";
import { git } from "./helpers/gitrepo.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { ScriptedRunner } from "./helpers/scripted-runner.ts";

/**
 * 新規開発向けに、最終確認を承認したタスクを、ツールがローカルの main に fast-forward で取り込む(push はしない)。
 * 同じプロジェクトのタスクは、前のタスクが取り込まれるまで次を始めない(fast-forward できるように1つずつ)
 */

async function setup(config: Partial<Config> = {}) {
  const runner = new ScriptedRunner(devScripts());
  const ctx = testContext(runner, config);
  const p = await approvedProject(ctx);
  setProjectSettingsRow(ctx.db, p.project.id, { integrate: "main" });
  return { ctx, runner, ...p };
}

/** 計画の承認 → 最終確認の承認まで進める */
async function toFinal(ctx: Awaited<ReturnType<typeof setup>>["ctx"], id: number) {
  await runUntilIdle(ctx);
  approveTask(ctx, id, "plan");
  await runUntilIdle(ctx);
  expect(getTask(ctx.db, id)!.state).toBe("awaiting_final_approval");
  approveTask(ctx, id, "final");
}

describe("main に取り込む(integrate: main)", () => {
  it("最終確認の承認の後、タスクのブランチを main に fast-forward で取り込んで完了。PR の下書きは作らず、remote には何も送らない", async () => {
    const { ctx, runner, project, repo, remote } = await setup();
    const t = newTask(ctx, project.id);
    await toFinal(ctx, t.id);
    const head = git(listTaskRepos(ctx.db, t.id)[0]!.worktreePath, "rev-parse", "HEAD");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("done");
    expect(git(repo, "rev-parse", "main")).toBe(head);
    // 人のリポジトリの作業ツリーも main に追従している
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(runner.calls.some((c) => c.role === "integrator")).toBe(false);
    expect(git(remote, "branch", "--list")).toBe("");
    expect(listEvents(ctx.db, t.id).find((e) => e.kind === "integrated")!.payload).toMatchObject({ into: "main", head });
    // 次の操作は main の push(人が行う)
    expect(nextActions(ctx.db, getTask(ctx.db, t.id)!)[0]!.command).toBe(`git -C ${repo} push origin main`);
  });

  it("同じプロジェクトのタスクは1つずつ。前のタスクが取り込まれるまで次を始めず、次は取り込んだ後の main から始める", async () => {
    const { ctx, project, repo } = await setup({ concurrency: 2 });
    const a = newTask(ctx, project.id, "a");
    const b = newTask(ctx, project.id, "b");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, a.id)!.state).toBe("awaiting_plan_approval");
    expect(getTask(ctx.db, b.id)!.state).toBe("queued");
    approveTask(ctx, a.id, "plan");
    await runUntilIdle(ctx);
    approveTask(ctx, a.id, "final");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, a.id)!.state).toBe("done");
    expect(getTask(ctx.db, b.id)!.state).toBe("awaiting_plan_approval");
    expect(listTaskRepos(ctx.db, b.id)[0]!.baseSha).toBe(git(repo, "rev-parse", "main"));
  });

  it("前のタスクが人の判断待ちのままでも、次は始めない。取り消せば次が始まる", async () => {
    const { ctx, project } = await setup();
    const a = newTask(ctx, project.id, "a");
    const b = newTask(ctx, project.id, "b");
    await runUntilIdle(ctx);
    const { cancelTask } = await import("../src/orchestrator/human.ts");
    expect(getTask(ctx.db, b.id)!.state).toBe("queued");
    cancelTask(ctx, a.id);
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, b.id)!.state).toBe("awaiting_plan_approval");
  });

  it("PR で取り込む既定のプロジェクトでは、これまでどおり並行して進める", async () => {
    const { ctx, project } = await setup({ concurrency: 2 });
    setProjectSettingsRow(ctx.db, project.id, {});
    const a = newTask(ctx, project.id, "a");
    const b = newTask(ctx, project.id, "b");
    await runUntilIdle(ctx);
    expect([a, b].map((t) => getTask(ctx.db, t.id)!.state)).toEqual(["awaiting_plan_approval", "awaiting_plan_approval"]);
  });

  it("人のリポジトリで main を開いていて未コミットの変更があれば、取り込まずに人に回す", async () => {
    const { ctx, project, repo } = await setup();
    const t = newTask(ctx, project.id);
    await toFinal(ctx, t.id);
    const before = git(repo, "rev-parse", "main");
    writeFileSync(join(repo, "README.md"), "人が編集中\n");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("needs_input");
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("未コミット");
    expect(git(repo, "rev-parse", "main")).toBe(before);
  });

  it("人のリポジトリで別のブランチを開いていれば、main のブランチだけを進める(開いているブランチと作業ツリーは変えない)", async () => {
    const { ctx, project, repo } = await setup();
    const t = newTask(ctx, project.id);
    await toFinal(ctx, t.id);
    git(repo, "checkout", "-q", "-b", "mine");
    const head = git(listTaskRepos(ctx.db, t.id)[0]!.worktreePath, "rev-parse", "HEAD");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("done");
    expect(git(repo, "rev-parse", "main")).toBe(head);
    expect(git(repo, "branch", "--show-current")).toBe("mine");
  });

  it("main が先に進んでいたら、取り込まずに追従を促す(これまでと同じ)", async () => {
    const { ctx, project, repo } = await setup();
    const t = newTask(ctx, project.id);
    await toFinal(ctx, t.id);
    writeFileSync(join(repo, "upstream.txt"), "x");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "upstream");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("needs_input");
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("update-base");
  });
});
