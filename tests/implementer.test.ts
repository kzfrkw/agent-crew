import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addEvent, getTask, listEvents, listTaskRepos, listValidApprovals, updateTaskState } from "../src/db/store.ts";
import { commitsSince } from "../src/git/worktree.ts";
import { latestNeedsInputReason, runUntilIdle, stepTask } from "../src/orchestrator/engine.ts";
import { verifyTests } from "../src/orchestrator/verify.ts";
import { approveTask } from "../src/orchestrator/human.ts";
import { taskDir } from "../src/orchestrator/paths.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { testContext } from "./helpers/context.ts";
import { sh } from "./helpers/gitrepo.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";

const plannerReady = answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false, design: { architect: false, designer: false, reason: "小さな変更" } });

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
  it("コミットしてレビューへ進む。コミットは trailer でエージェントのものと分かる", async () => {
    const runner = new ScriptedRunner({
      planner: plannerReady,
      implementer: implementer(),
      verifier: () => ({ structuredOutput: { verdict: "passed", summary: "s" }, bashResults: [{ command: "npm test", isError: false, output: "ok" }] }),
      reviewer: answer("review.md", "approve", { findings: [] }),
      qa: answer("qa-report.md", "passed"),
    });
    const { ctx, t } = await toImplementing(runner);
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
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

  it("最初の実装で、変更もコミットも無いまま done なら needs_input", async () => {
    const runner = new ScriptedRunner({
      planner: plannerReady,
      implementer: (spec) => {
        writeArtifact(spec, "impl-notes.md", "done");
        return { structuredOutput: { verdict: "done", summary: "何もしていない", testCommand: null } };
      },
    });
    const { ctx, t } = await toImplementing(runner);
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("needs_input");
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("コミットがありません");
  });

  it("差し戻しの後は、原因が環境でコードを直す必要が無ければ、新しいコミットなしの done でも警告を残してテストの再実行に進む(フェーズ4bで判明)", async () => {
    const runner = new ScriptedRunner({
      planner: plannerReady,
      implementer: (spec, n) => {
        if (n === 0) return implementer()(spec);
        // 2回目: テストの失敗は環境の問題で、コードの変更は不要と判断した
        writeArtifact(spec, "impl-notes.md", "done");
        return { structuredOutput: { verdict: "done", summary: "失敗は依存の壊れで、コードの変更は不要です", testCommand: null } };
      },
      verifier: (spec, n) => ({ structuredOutput: { verdict: n === 0 ? "failed" : "passed", summary: "s" }, bashResults: [{ command: "npm test", isError: n === 0, output: n === 0 ? "vitest: command not found" : "ok" }] }),
      reviewer: answer("review.md", "approve", { findings: [] }),
      qa: answer("qa-report.md", "passed"),
    });
    const { ctx, t } = await toImplementing(runner);
    // 1回目のテストの再実行の後で、人が依存を直した(worktree のコミットは同じなので、キャッシュを使わず再実行させる)
    await runUntilIdle(ctx);
    expect(runner.rolesCalled().filter((r) => r === "verifier")).toHaveLength(2);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
    expect(listEvents(ctx.db, t.id).some((e) => e.kind === "warning" && JSON.stringify(e.payload).includes("新しいコミットなし"))).toBe(true);
  });

  it("回答で再開した場合(差し戻しの回数が0に戻る)も、ブランチに実装があれば同じく進む", async () => {
    const runner = new ScriptedRunner({
      planner: plannerReady,
      implementer: (spec, n) => {
        if (n === 0) return implementer()(spec);
        writeArtifact(spec, "impl-notes.md", "done");
        return { structuredOutput: { verdict: "done", summary: "コードの変更は不要です", testCommand: null } };
      },
      verifier: (spec, n) => ({ structuredOutput: { verdict: n === 0 ? "failed" : "passed", summary: "s" }, bashResults: [{ command: "npm test", isError: n === 0, output: "" }] }),
      reviewer: answer("review.md", "approve", { findings: [] }),
      qa: answer("qa-report.md", "passed"),
    });
    const { ctx, t } = await toImplementing(runner, {});
    // 1回目: 実装 → テストの再実行が失敗して差し戻し。人が回答で止めて再開した状況を、回数を0に戻して作る
    await stepTask(ctx, t.id);
    await stepTask(ctx, t.id);
    expect(getTask(ctx.db, t.id)!.state).toBe("implementing");
    updateTaskState(ctx.db, t.id, { state: "implementing", reviewRounds: 0 });
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
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
    expect(listEvents(ctx.db, t.id).find((e) => e.kind === "test_command")?.payload).toEqual({ command: "node --test", repoId: expect.any(Number) }) // リポジトリごとに記録する(フェーズ5);
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

  it("依存の準備コマンドは実行しない(準備は worktree に書ける実装者の責任。サンドボックスでの入れ直しは失敗することがある)", async () => {
    const { ctx, t, runner } = await reviewing(bash("npm test", false), {
      commands: { install: "npm ci", build: null, test: "npm test", start: null },
    });
    expect(await verifyTests(ctx, getTask(ctx.db, t.id)!)).toMatchObject({ status: "passed", command: "npm test" });
    expect(runner.calls.find((c) => c.role === "verifier")!.prompt).not.toContain("npm ci");
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

describe("verifyTests(Flutter: ツールが sandbox-exec で直接実行する。フェーズ6)", () => {
  const flutterProfile = { platform: "flutter" as const, commands: { install: "flutter pub get", build: null, test: "flutter test", start: null, analyze: "flutter analyze" }, startUrl: null };
  async function reviewing(exitCode: number) {
    const runner = new ScriptedRunner({ planner: plannerReady, implementer: implementer() });
    const ctx = testContext(runner);
    const calls: { cwd: string; command: string; platform: string }[] = [];
    ctx.toolExec = async (_ctx, req) => {
      calls.push({ cwd: req.cwd, command: req.command, platform: req.platform });
      return { exitCode, timedOut: false, output: exitCode === 0 ? "All tests passed!" : "Some tests failed.", durationMs: 10 };
    };
    const { project } = await approvedProject(ctx, flutterProfile);
    const t = newTask(ctx, project.id);
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "plan");
    await runUntilIdle(ctx);
    return { ctx, t, runner, calls };
  }

  it("claude(verifier)を使わず、ツールがテストを実行して終了コードで判定する", async () => {
    const { ctx, t, runner, calls } = await reviewing(0);
    expect(runner.calls.filter((c) => c.role === "verifier")).toHaveLength(0);
    expect(calls[0]).toMatchObject({ command: "flutter test", platform: "flutter" });
    expect(calls[0]!.cwd).toBe(listTaskRepos(ctx.db, t.id)[0]!.worktreePath);
    expect(listValidApprovals(ctx.db, t.id).find((a) => a.kind === "tests")).toMatchObject({ result: "approved" });
    expect(listEvents(ctx.db, t.id, 100).some((e) => e.kind === "tool_command")).toBe(true);
    expect(await verifyTests(ctx, getTask(ctx.db, t.id)!)).toMatchObject({ status: "passed", cached: true });
  });

  it("終了コードが 0 でなければ failed。出力を報告に残す", async () => {
    const { ctx, t } = await reviewing(1);
    const r = await verifyTests(ctx, getTask(ctx.db, t.id)!);
    expect(r).toMatchObject({ status: "failed" });
    expect(readFileSync(join(taskDir(ctx.home, t.id), "verify-report.md"), "utf8")).toContain("Some tests failed.");
  });
});

