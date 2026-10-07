import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addEvent, getTask, listEvents, listTaskRepos, listValidApprovals } from "../src/db/store.ts";
import { commitsSince } from "../src/git/worktree.ts";
import { latestNeedsInputReason, runUntilIdle } from "../src/orchestrator/engine.ts";
import { verifyTests } from "../src/orchestrator/verify.ts";
import { approveTask } from "../src/orchestrator/human.ts";
import { taskDir } from "../src/orchestrator/paths.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { testContext } from "./helpers/context.ts";
import { sh } from "./helpers/gitrepo.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";

const plannerReady = answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false });

/** 実装者の台本: ファイルを書いて、渡された環境変数でコミットする(フックが trailer を付ける) */
const implementer =
  (o: { commit?: boolean; dirty?: boolean; testCommand?: string | null } = {}) =>
  (spec: RunSpec) => {
    writeFileSync(join(spec.cwd, "feature.js"), `export const f = ${Date.now()};\n`);
    if (o.commit !== false) {
      const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...spec.extraEnv };
      sh(spec.cwd, "git", ["add", "."], env);
      sh(spec.cwd, "git", ["commit", "-q", "-m", "feat: 在庫0を除外"], env);
    }
    if (o.dirty) writeFileSync(join(spec.cwd, "leftover.js"), "x");
    writeArtifact(spec, "impl-notes.md", "done");
    return { structuredOutput: { verdict: "done", summary: "実装した", testCommand: o.testCommand ?? null } };
  };

async function toImplementing(runner: ScriptedRunner, profile = {}) {
  const ctx = testContext(runner);
  const { project } = await approvedProject(ctx, profile);
  const t = newTask(ctx, project.id);
  await runUntilIdle(ctx);
  approveTask(ctx, t.id, "plan");
  return { ctx, t };
}

describe("実装者", () => {
  it("コミットして reviewing へ。コミットは trailer でエージェントのものと分かる", async () => {
    const runner = new ScriptedRunner({ planner: plannerReady, implementer: implementer() });
    const { ctx, t } = await toImplementing(runner);
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("reviewing");
    const tr = listTaskRepos(ctx.db, t.id)[0]!;
    const commits = commitsSince(tr.worktreePath, tr.baseSha, ctx.gitEnv);
    expect(commits.map((c) => [c.author, c.agentRole])).toEqual([["agent-crew implementer", "implementer"]]);
    const call = runner.calls.find((c) => c.role === "implementer")!;
    expect(call).toMatchObject({ write: "worktree", cwd: tr.worktreePath });
    expect(call.extraEnv).toMatchObject({ AGENT_CREW_ROLE: "implementer", GIT_AUTHOR_NAME: "agent-crew implementer" });
    expect(listEvents(ctx.db, t.id).some((e) => e.kind === "implemented")).toBe(true);
  });

  it("done でもコミットが無ければ needs_input", async () => {
    const runner = new ScriptedRunner({ planner: plannerReady, implementer: implementer({ commit: false }) });
    const { ctx, t } = await toImplementing(runner);
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("needs_input");
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("コミット");
  });

  it("未コミットの変更が残っていれば needs_input", async () => {
    const runner = new ScriptedRunner({ planner: plannerReady, implementer: implementer({ dirty: true }) });
    const { ctx, t } = await toImplementing(runner);
    await runUntilIdle(ctx);
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("未コミット");
  });

  it("テストコマンドを新しく用意したら記録する(テスト基盤整備など)", async () => {
    const runner = new ScriptedRunner({ planner: plannerReady, implementer: implementer({ testCommand: "node --test" }) });
    const { ctx, t } = await toImplementing(runner);
    await runUntilIdle(ctx);
    expect(listEvents(ctx.db, t.id).find((e) => e.kind === "test_command")?.payload).toEqual({ command: "node --test" });
  });
});

describe("verifyTests(テストの再実行)", () => {
  async function reviewing(verifier: Script, profile = {}) {
    const runner = new ScriptedRunner({ planner: plannerReady, implementer: implementer(), verifier });
    const { ctx, t } = await toImplementing(runner, profile);
    await runUntilIdle(ctx);
    return { ctx, t, runner };
  }
  const bash = (command: string, isError: boolean) => () => ({
    structuredOutput: { verdict: isError ? "failed" : "passed", summary: "s" },
    bashResults: [{ command, isError, output: isError ? "1 failing" : "ok" }],
  });

  it("合否はモデルの申告ではなく Bash の終了状態で決め、HEAD に紐づけて記録する", async () => {
    const { ctx, t, runner } = await reviewing(() => ({
      structuredOutput: { verdict: "passed", summary: "嘘" },
      bashResults: [{ command: "npm test", isError: true, output: "1 failing" }],
    }));
    const r = await verifyTests(ctx, getTask(ctx.db, t.id)!);
    expect(r).toMatchObject({ status: "failed" });
    const call = runner.calls.find((c) => c.role === "verifier")!;
    expect(call.prompt).toContain("npm test");
    expect(call).toMatchObject({ write: "artifacts", bashWritesWorktree: true });
    expect(readFileSync(join(taskDir(ctx.home, t.id), "verify-report.md"), "utf8")).toContain("1 failing");
    expect(listValidApprovals(ctx.db, t.id).find((a) => a.kind === "tests")).toMatchObject({ result: "rejected" });
  });

  it("成功すれば passed。同じ HEAD は再実行しない", async () => {
    const { ctx, t, runner } = await reviewing(bash("npm test", false));
    expect(await verifyTests(ctx, getTask(ctx.db, t.id)!)).toMatchObject({ status: "passed" });
    expect(await verifyTests(ctx, getTask(ctx.db, t.id)!)).toMatchObject({ status: "passed", cached: true });
    expect(runner.calls.filter((c) => c.role === "verifier")).toHaveLength(1);
  });

  it("指定のコマンドを実行しなかったら error", async () => {
    const { ctx, t } = await reviewing(bash("npm run lint", false));
    expect(await verifyTests(ctx, getTask(ctx.db, t.id)!)).toMatchObject({ status: "error" });
  });

  it("依存の準備コマンドがあれば、続けて実行する", async () => {
    const { ctx, t, runner } = await reviewing(bash("npm ci && npm test", false), {
      commands: { install: "npm ci", build: null, test: "npm test", start: null },
    });
    expect(await verifyTests(ctx, getTask(ctx.db, t.id)!)).toMatchObject({ status: "passed" });
    expect(runner.calls.find((c) => c.role === "verifier")!.prompt).toContain("npm ci && npm test");
  });

  it("実装者が記録したテストコマンドを優先する", async () => {
    const { ctx, t } = await reviewing(bash("node --test", false));
    addEvent(ctx.db, { taskId: t.id, kind: "test_command", payload: { command: "node --test" } });
    expect(await verifyTests(ctx, getTask(ctx.db, t.id)!)).toMatchObject({ status: "passed", command: "node --test" });
  });

  it("テストコマンドが無ければ skipped", async () => {
    const { ctx, t } = await reviewing(bash("x", false), { commands: { install: null, build: null, test: null, start: null } });
    expect(await verifyTests(ctx, getTask(ctx.db, t.id)!)).toMatchObject({ status: "skipped" });
  });
});
