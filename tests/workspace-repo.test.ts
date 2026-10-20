import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask, listEvents, listTaskRepos, setProjectSettingsRow } from "../src/db/store.ts";
import { runUntilIdle } from "../src/orchestrator/engine.ts";
import { approveTask, cancelTask } from "../src/orchestrator/human.ts";
import { agentHooksDir } from "../src/git/hooks.ts";
import type { Config } from "../src/config/config.ts";
import { testContext } from "./helpers/context.ts";
import { devScripts } from "./helpers/dev-scripts.ts";
import { git } from "./helpers/gitrepo.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { ScriptedRunner } from "./helpers/scripted-runner.ts";

/**
 * 人のリポジトリで直接作業する(workspace: repo。v0.25)。worktree を作らず、人のリポジトリでタスクのブランチに切り替えて作業する。
 * Xcode の設定、.gitignore されたファイル、社内ライブラリへのシンボリックリンクがそのまま使える代わりに、タスクは1つずつ、
 * 人の未コミットの変更があれば始めない。.git/hooks と .git/config はエージェントに書かせない
 */

async function setup(config: Partial<Config> = {}, workspace: "repo" | "worktree" = "repo") {
  const runner = new ScriptedRunner(devScripts());
  const ctx = testContext(runner, config);
  const p = await approvedProject(ctx);
  setProjectSettingsRow(ctx.db, p.project.id, { workspace, explain: false });
  return { ctx, runner, ...p };
}

describe("人のリポジトリで直接作業する(workspace: repo)", () => {
  it("worktree を作らず、人のリポジトリでタスクのブランチに切り替えて作業する。役割はリポジトリで動く", async () => {
    const { ctx, runner, project, repo } = await setup();
    const t = newTask(ctx, project.id);
    await runUntilIdle(ctx);
    const tr = listTaskRepos(ctx.db, t.id)[0]!;
    expect(realpathSync(tr.worktreePath)).toBe(realpathSync(repo));
    expect(git(repo, "branch", "--show-current")).toBe(tr.branchName);
    expect(existsSync(join(ctx.home, "worktrees", "shop", String(t.id)))).toBe(false);
    expect(realpathSync(runner.calls.find((c) => c.role === "planner")!.cwd)).toBe(realpathSync(repo));
  });

  it("完了したら元のブランチに戻す。タスクのブランチとリポジトリは残す", async () => {
    const { ctx, project, repo } = await setup();
    const t = newTask(ctx, project.id);
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "plan");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
    const branch = listTaskRepos(ctx.db, t.id)[0]!.branchName;
    expect(git(repo, "log", "-1", "--format=%s", branch)).toBe("feat 0");
    approveTask(ctx, t.id, "final");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("done");
    expect(git(repo, "branch", "--show-current")).toBe("main");
    expect(git(repo, "branch", "--list", branch)).toContain(branch);
    expect(existsSync(join(repo, "README.md"))).toBe(true);
    expect(listEvents(ctx.db, t.id).some((e) => e.kind === "worktree_removed")).toBe(false);
  });

  it("取り消しでも元のブランチに戻す", async () => {
    const { ctx, project, repo } = await setup();
    const t = newTask(ctx, project.id);
    await runUntilIdle(ctx);
    cancelTask(ctx, t.id);
    expect(git(repo, "branch", "--show-current")).toBe("main");
  });

  it("エージェントの git にだけ push を止めるフックを効かせ、.git/hooks と .git/config には書かせない", async () => {
    const { ctx, runner, project, repo } = await setup();
    const t = newTask(ctx, project.id);
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "plan");
    await runUntilIdle(ctx);
    const impl = runner.calls.find((c) => c.role === "implementer")!;
    expect(impl.extraEnv).toMatchObject({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: agentHooksDir(ctx.home) });
    const real = realpathSync(repo);
    expect(impl.denyWrite).toEqual(expect.arrayContaining([join(real, ".git", "hooks"), join(real, ".git", "config")]));
    // 人のリポジトリの設定は変えない(フックの場所は人の git には効かない)
    expect(() => git(repo, "config", "--get", "core.hooksPath")).toThrow();
  });

  it("人の未コミットの変更(追跡しているファイル)があれば始めずに待つ。きれいになったら始める", async () => {
    const { ctx, project, repo } = await setup();
    writeFileSync(join(repo, "README.md"), "人が編集中\n");
    const t = newTask(ctx, project.id);
    await runUntilIdle(ctx);
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("queued");
    expect(listEvents(ctx.db, t.id).filter((e) => e.kind === "waiting_repo")).toHaveLength(1);
    git(repo, "checkout", "--", "README.md");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_plan_approval");
  });

  it("終わったときに人の未コミットの変更があれば戻さずに警告する。片付けのたびに同じ警告を重ねない。きれいになったら戻す", async () => {
    const { ctx, project, repo } = await setup();
    const t = newTask(ctx, project.id);
    await runUntilIdle(ctx);
    writeFileSync(join(repo, "README.md"), "人が編集中\n");
    cancelTask(ctx, t.id);
    await runUntilIdle(ctx);
    await runUntilIdle(ctx);
    const branch = listTaskRepos(ctx.db, t.id)[0]!.branchName;
    expect(git(repo, "branch", "--show-current")).toBe(branch);
    expect(listEvents(ctx.db, t.id).filter((e) => e.kind === "warning")).toHaveLength(1);
    git(repo, "checkout", "--", "README.md");
    await runUntilIdle(ctx);
    expect(git(repo, "branch", "--show-current")).toBe("main");
  });

  it("同じプロジェクトのタスクは1つずつ", async () => {
    const { ctx, project } = await setup({ concurrency: 2 });
    const a = newTask(ctx, project.id, "a");
    const b = newTask(ctx, project.id, "b");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, a.id)!.state).toBe("awaiting_plan_approval");
    expect(getTask(ctx.db, b.id)!.state).toBe("queued");
    cancelTask(ctx, a.id);
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, b.id)!.state).toBe("awaiting_plan_approval");
  });

  it("worktree で作業する既定のプロジェクトでは、これまでどおり(環境変数のフックも書き込みの禁止も足さない)", async () => {
    const { ctx, runner, project } = await setup({}, "worktree");
    const t = newTask(ctx, project.id);
    await runUntilIdle(ctx);
    const planner = runner.calls.find((c) => c.role === "planner")!;
    expect(planner.cwd).toContain(join("worktrees", "shop", String(t.id)));
    expect(planner.extraEnv?.GIT_CONFIG_COUNT).toBeUndefined();
    expect(planner.denyWrite ?? []).toEqual([]);
  });
});
