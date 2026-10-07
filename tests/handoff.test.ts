import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask, listTaskRepos, listValidApprovals, startRun } from "../src/db/store.ts";
import { commitsSince, isDirty } from "../src/git/worktree.ts";
import { latestNeedsInputReason, runnableTasks, runUntilIdle } from "../src/orchestrator/engine.ts";
import { returnTask, takeoverTask, updateBase } from "../src/orchestrator/handoff.ts";
import { approveTask } from "../src/orchestrator/human.ts";
import { taskDir } from "../src/orchestrator/paths.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { testContext } from "./helpers/context.ts";
import { git, gitEnv, sh } from "./helpers/gitrepo.ts";
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
  verifier: (spec) => {
    const command = /```sh\n(.*)\n```/.exec(spec.prompt)![1]!;
    return { structuredOutput: { verdict: "passed", summary: "s" }, bashResults: [{ command, isError: false, output: "ok" }] };
  },
  reviewer: answer("review.md", "approve"),
  qa: answer("qa-report.md", "passed"),
  integrator: answer("pr-draft.md", "done"),
};

/** 最終確認待ちまで進めたタスク */
async function awaitingFinal() {
  const runner = new ScriptedRunner(scripts);
  const ctx = testContext(runner);
  const p = await approvedProject(ctx);
  const t = newTask(ctx, p.project.id);
  await runUntilIdle(ctx);
  approveTask(ctx, t.id, "plan");
  await runUntilIdle(ctx);
  const wt = listTaskRepos(ctx.db, t.id)[0]!.worktreePath;
  return { ctx, t, runner, wt, ...p };
}

const human = { ...gitEnv(), GIT_AUTHOR_NAME: "Human", GIT_COMMITTER_NAME: "Human" };
const humanCommit = (wt: string, file: string, msg: string) => {
  writeFileSync(join(wt, file), "by human\n");
  sh(wt, "git", ["add", "."], human);
  sh(wt, "git", ["commit", "-q", "-m", msg], human);
};

describe("人が引き取る / エージェントに戻す", () => {
  it("引き取ると human_working になり、エージェントは動かない", async () => {
    const { ctx, t, wt } = await awaitingFinal();
    const r = takeoverTask(ctx, t.id);
    expect(r.worktrees).toEqual([wt]);
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "human_working", assignee: "human", heldFromState: "awaiting_final_approval" });
    expect(runnableTasks(ctx).map((x) => x.id)).not.toContain(t.id);
  });

  it("エージェントの実行中は引き取れない", async () => {
    const { ctx, t } = await awaitingFinal();
    startRun(ctx.db, { taskId: t.id, role: "qa" });
    expect(() => takeoverTask(ctx, t.id)).toThrow(/実行中/);
  });

  it("変更なしで戻すと元の状態に戻り、承認はそのまま", async () => {
    const { ctx, t } = await awaitingFinal();
    takeoverTask(ctx, t.id);
    expect(returnTask(ctx, t.id)).toMatchObject({ humanChanged: false });
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
    expect(listValidApprovals(ctx.db, t.id).map((a) => a.kind)).toEqual(expect.arrayContaining(["review", "qa"]));
  });

  it("未コミットの変更があれば戻す操作を拒否する", async () => {
    const { ctx, t, wt } = await awaitingFinal();
    takeoverTask(ctx, t.id);
    writeFileSync(join(wt, "wip.js"), "x");
    expect(() => returnTask(ctx, t.id)).toThrow(/未コミット/);
    expect(getTask(ctx.db, t.id)!.state).toBe("human_working");
  });

  it("人がコミットして戻すと、承認を失効させてレビューからやり直し、人の変更を次の入力に加える", async () => {
    const { ctx, t, wt, runner } = await awaitingFinal();
    takeoverTask(ctx, t.id);
    humanCommit(wt, "manual.js", "fix: 人が手で直した");
    expect(returnTask(ctx, t.id)).toMatchObject({ humanChanged: true });
    expect(getTask(ctx.db, t.id)!.state).toBe("reviewing");
    expect(listValidApprovals(ctx.db, t.id).filter((a) => ["review", "qa", "final"].includes(a.kind))).toEqual([]);
    const changes = readFileSync(join(taskDir(ctx.home, t.id), "human-changes.md"), "utf8");
    expect(changes).toContain("人が手で直した");
    expect(changes).toContain("manual.js");

    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
    const review = runner.calls.filter((c) => c.role === "reviewer").at(-1)!;
    expect(review.prompt).toContain("人が手で直した");
    expect(review.prompt).toContain("human-changes.md");
  });
});

describe("ベース更新", () => {
  it("取り込んだらレビューからやり直す。マージコミットは人の変更として扱わない", async () => {
    const { ctx, t, wt, repo } = await awaitingFinal();
    writeFileSync(join(repo, "upstream.txt"), "x");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "upstream");
    expect(updateBase(ctx, t.id)).toMatchObject({ updated: true });
    expect(getTask(ctx.db, t.id)!.state).toBe("reviewing");
    expect(existsSync(join(wt, "upstream.txt"))).toBe(true);
    const tr = listTaskRepos(ctx.db, t.id)[0]!;
    const merge = commitsSince(wt, tr.baseSha, ctx.gitEnv).at(-1)!;
    expect(merge.agentRole).toBe("base-update");
  });

  it("すでに追従済みなら何もしない", async () => {
    const { ctx, t } = await awaitingFinal();
    expect(updateBase(ctx, t.id)).toMatchObject({ updated: false });
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
  });

  it("衝突したらマージを中止して needs_input", async () => {
    const { ctx, t, wt, repo } = await awaitingFinal();
    writeFileSync(join(repo, "f0.js"), "conflict from upstream\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "upstream conflict");
    expect(updateBase(ctx, t.id)).toMatchObject({ updated: false, conflict: true });
    expect(isDirty(wt, ctx.gitEnv)).toBe(false);
    expect(getTask(ctx.db, t.id)!.state).toBe("needs_input");
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("衝突");
  });

  it("人が作業中は拒否する", async () => {
    const { ctx, t } = await awaitingFinal();
    takeoverTask(ctx, t.id);
    expect(() => updateBase(ctx, t.id)).toThrow();
  });
});
