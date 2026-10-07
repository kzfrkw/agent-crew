import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getProject, getRepoProfile, getTask, listEvents, listRepos } from "../src/db/store.ts";
import { latestNeedsInputReason, runUntilIdle } from "../src/orchestrator/engine.ts";
import { approveTask } from "../src/orchestrator/human.ts";
import { taskDir } from "../src/orchestrator/paths.ts";
import { testGateOpen } from "../src/orchestrator/projects.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { testContext } from "./helpers/context.ts";
import { git, sh } from "./helpers/gitrepo.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";

const env = (spec: RunSpec) => ({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...spec.extraEnv });
const scripts = (over: Record<string, Script> = {}): Record<string, Script> => ({
  planner: answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false }),
  implementer: (spec, n) => {
    writeFileSync(join(spec.cwd, `f${n}.js`), "x");
    sh(spec.cwd, "git", ["add", "."], env(spec));
    sh(spec.cwd, "git", ["commit", "-q", "-m", `feat ${n}`], env(spec));
    writeArtifact(spec, "impl-notes.md", "done");
    return { structuredOutput: { verdict: "done", summary: "s", testCommand: null } };
  },
  verifier: (spec) => {
    const command = /```sh\n(.*)\n```/.exec(spec.prompt)![1]!;
    return { structuredOutput: { verdict: "passed", summary: "s" }, bashResults: [{ command, isError: false, output: "ok" }] };
  },
  reviewer: answer("review.md", "approve"),
  qa: answer("qa-report.md", "passed"),
  integrator: answer("pr-draft.md", "done"),
  ...over,
});

async function finalApproved(over: Record<string, Script> = {}, profile = {}) {
  const runner = new ScriptedRunner(scripts(over));
  const ctx = testContext(runner);
  const p = await approvedProject(ctx, profile);
  const t = p.testInfraTask ?? newTask(ctx, p.project.id);
  await runUntilIdle(ctx);
  approveTask(ctx, t.id, "plan");
  await runUntilIdle(ctx);
  expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
  approveTask(ctx, t.id, "final");
  return { ctx, t, runner, ...p };
}

describe("統合担当", () => {
  it("PR本文の下書きを作って done。remote には何も送らない", async () => {
    const { ctx, t, runner, remote } = await finalApproved();
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("done");
    expect(existsSync(join(taskDir(ctx.home, t.id), "pr-draft.md"))).toBe(true);
    const call = runner.calls.find((c) => c.role === "integrator")!;
    expect(call.write).toBe("artifacts");
    expect(call.prompt).toContain(`agent-crew/${t.id}`);
    expect(call.prompt).toContain("feat 0");
    expect(git(remote, "branch", "--list")).toBe("");
    expect(listEvents(ctx.db, t.id).find((e) => e.kind === "integrated")!.payload).toMatchObject({ branch: expect.stringContaining("agent-crew/") });
  });

  it("ベースが進んでいたら needs_input で追従を促す", async () => {
    const { ctx, t, repo } = await finalApproved();
    writeFileSync(join(repo, "upstream.txt"), "x");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "upstream");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("needs_input");
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("update-base");
  });

  it("最終確認の後にコミットが増えていたら needs_input", async () => {
    const { ctx, t } = await finalApproved();
    const wt = join(ctx.home, "worktrees", "shop", String(t.id), "main");
    writeFileSync(join(wt, "late.js"), "x");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "late");
    await runUntilIdle(ctx);
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("最終確認");
  });

  it("blocked なら needs_input", async () => {
    const { ctx, t } = await finalApproved({ integrator: answer("pr-draft.md", "blocked") });
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("needs_input");
  });

  it("テスト基盤整備タスクが完了すると、テスト基盤ありになり、通常タスクのゲートが開く", async () => {
    const { ctx, t, project } = await finalApproved(
      {
        implementer: (spec, n) => {
          writeFileSync(join(spec.cwd, `t${n}.test.js`), "x");
          sh(spec.cwd, "git", ["add", "."], env(spec));
          sh(spec.cwd, "git", ["commit", "-q", "-m", "test infra"], env(spec));
          writeArtifact(spec, "impl-notes.md", "done");
          return { structuredOutput: { verdict: "done", summary: "s", testCommand: "node --test" } };
        },
      },
      { testInfra: "none", commands: { install: null, build: null, test: null, start: "npm start" } },
    );
    expect(t.kind).toBe("test_infra");
    const normal = newTask(ctx, project.id);
    expect(testGateOpen(ctx.db, normal.id)).toBe(false);
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("done");
    expect(getProject(ctx.db, project.id)!.testInfra).toBe("present");
    const repo = listRepos(ctx.db, project.id)[0]!;
    expect((getRepoProfile(ctx.db, repo.id) as { commands: { test: string } }).commands.test).toBe("node --test");
    expect(testGateOpen(ctx.db, normal.id)).toBe(true);
  });
});
