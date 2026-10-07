import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask, listArtifacts, listEvents, listTaskRepos, createProject } from "../src/db/store.ts";
import { runUntilIdle, applyEvent, latestNeedsInputReason } from "../src/orchestrator/engine.ts";
import { answerTask, approveTask, rejectTask, cancelTask } from "../src/orchestrator/human.ts";
import { taskDir } from "../src/orchestrator/paths.ts";
import { branchNameFor } from "../src/git/worktree.ts";
import { git } from "./helpers/gitrepo.ts";
import { testContext } from "./helpers/context.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner } from "./helpers/scripted-runner.ts";

const plannerReady = answer("plan.md", "ready", { acceptanceCriteria: ["在庫0を返さない"], testFirstException: false });

describe("開始とプランナー", () => {
  it("queued → worktree を作って planning → 計画承認待ち", async () => {
    const runner = new ScriptedRunner({ planner: plannerReady });
    const ctx = testContext(runner);
    const { project, repo } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    await runUntilIdle(ctx);

    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "awaiting_plan_approval", assignee: null });
    const [tr] = listTaskRepos(ctx.db, t.id);
    expect(tr!.worktreePath).toBe(join(ctx.home, "worktrees", "shop", String(t.id), "main"));
    expect(tr!.branchName).toBe(branchNameFor(t.id, t.title));
    expect(tr!.baseSha).toBe(git(repo, "rev-parse", "main"));
    expect(git(tr!.worktreePath, "branch", "--show-current")).toBe(tr!.branchName);

    const call = runner.calls[0]!;
    expect(call).toMatchObject({ role: "planner", cwd: tr!.worktreePath, artifactsDir: taskDir(ctx.home, t.id) });
    expect(call.prompt).toContain("在庫が0のアイテムを除外する");
    expect(call.prompt).toContain("GET /api/items で在庫0を返さない");
    expect(call.prompt).toContain("profile.md");
    expect(call.prompt).toContain("decisions.md");
    expect(listArtifacts(ctx.db, t.id).map((a) => a.kind)).toEqual(["plan"]);
    expect(listEvents(ctx.db, t.id).filter((e) => e.kind === "state_changed").map((e) => (e.payload as { to: string }).to)).toEqual([
      "planning",
      "awaiting_plan_approval",
    ]);
  });

  it("プロファイル未承認のプロジェクトのタスクは開始しない", async () => {
    const runner = new ScriptedRunner({ planner: plannerReady });
    const ctx = testContext(runner);
    const p = createProject(ctx.db, { name: "raw" });
    const t = newTask(ctx, p.id);
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("queued");
    expect(runner.calls).toHaveLength(0);
  });

  it("テスト基盤の整備前は、整備タスクだけが進む", async () => {
    const runner = new ScriptedRunner({ planner: plannerReady });
    const ctx = testContext(runner);
    const { project, testInfraTask } = await approvedProject(ctx, { testInfra: "none" });
    const normal = newTask(ctx, project.id);
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, testInfraTask!.id)!.state).toBe("awaiting_plan_approval");
    expect(getTask(ctx.db, normal.id)!.state).toBe("queued");
  });

  it("同時実行数の上限まで並行して進める", async () => {
    let running = 0;
    let peak = 0;
    const runner = new ScriptedRunner({
      planner: async (spec, n) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 50));
        running--;
        return plannerReady(spec, n);
      },
    });
    const ctx = testContext(runner, { concurrency: 2 });
    const { project } = await approvedProject(ctx);
    const ts = [newTask(ctx, project.id, "a"), newTask(ctx, project.id, "b"), newTask(ctx, project.id, "c")];
    await runUntilIdle(ctx);
    expect(ts.map((t) => getTask(ctx.db, t.id)!.state)).toEqual(Array(3).fill("awaiting_plan_approval"));
    expect(peak).toBe(2);
  });
});

describe("人の判断が必要なとき", () => {
  it("need_human → needs_input(理由を残す)→ 回答すると、回答を入力に加えて再開する", async () => {
    const runner = new ScriptedRunner({
      planner: (spec, n) => (n === 0 ? answer("plan.md", "need_human", { acceptanceCriteria: [], testFirstException: false })(spec, n) : plannerReady(spec, n)),
    });
    const ctx = testContext(runner);
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "planning" });
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("planner");

    answerTask(ctx, t.id, "在庫0は一覧から除外し、個別取得では返してよい");
    expect(readFileSync(join(taskDir(ctx.home, t.id), "human-notes.md"), "utf8")).toContain("個別取得では返してよい");
    expect(getTask(ctx.db, t.id)!.state).toBe("planning");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_plan_approval");
    expect(runner.calls[1]!.prompt).toContain("human-notes.md");
  });

  it("成果物が無いなどの実行エラーは needs_input になり、理由が分かる", async () => {
    const runner = new ScriptedRunner({ planner: () => ({ structuredOutput: { verdict: "ready", summary: "s", acceptanceCriteria: [], testFirstException: false } }) });
    const ctx = testContext(runner);
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("needs_input");
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("plan.md");
  });
});

describe("計画の承認・却下・取り消し", () => {
  async function planned() {
    const runner = new ScriptedRunner({ planner: plannerReady });
    const ctx = testContext(runner);
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    await runUntilIdle(ctx);
    return { ctx, t, runner };
  }

  it("承認すると implementing", async () => {
    const { ctx, t } = await planned();
    approveTask(ctx, t.id, "plan", "OK");
    expect(getTask(ctx.db, t.id)!.state).toBe("implementing");
  });

  it("却下するとコメントを残してプランナーに戻す", async () => {
    const { ctx, t, runner } = await planned();
    rejectTask(ctx, t.id, "plan", "受け入れ条件に404のケースを足して");
    expect(getTask(ctx.db, t.id)!.state).toBe("planning");
    await runUntilIdle(ctx);
    expect(runner.calls).toHaveLength(2);
    expect(readFileSync(join(taskDir(ctx.home, t.id), "human-notes.md"), "utf8")).toContain("404のケース");
  });

  it("承認待ちでないときの承認はエラー", async () => {
    const { ctx, t } = await planned();
    expect(() => approveTask(ctx, t.id, "final")).toThrow();
  });

  it("取り消せる", async () => {
    const { ctx, t } = await planned();
    cancelTask(ctx, t.id);
    expect(getTask(ctx.db, t.id)!.state).toBe("cancelled");
  });
});

describe("applyEvent", () => {
  it("状態変更をイベントに残す", async () => {
    const ctx = testContext(new ScriptedRunner({}));
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    applyEvent(ctx, t.id, { type: "cancel" });
    const ev = listEvents(ctx.db, t.id).find((e) => e.kind === "state_changed")!;
    expect(ev.payload).toMatchObject({ from: "queued", to: "cancelled", event: "cancel" });
  });

  it("worktree は作られていない状態でも取り消しできる", async () => {
    const ctx = testContext(new ScriptedRunner({}));
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    cancelTask(ctx, t.id);
    expect(existsSync(join(ctx.home, "worktrees", "shop", String(t.id)))).toBe(false);
  });
});

describe("エージェント用フックの更新", () => {
  it("実行を始めるたびに、フックを最新の内容に書き直す(古いworktreeにも効く)", async () => {
    const { writeFileSync: w, readFileSync: r } = await import("node:fs");
    const ctx = testContext(new ScriptedRunner({}));
    await approvedProject(ctx);
    w(join(ctx.home, "hooks", "prepare-commit-msg"), "#!/bin/sh\n# 古い\n");
    await runUntilIdle(ctx);
    expect(r(join(ctx.home, "hooks", "prepare-commit-msg"), "utf8")).toContain("Agent-Crew-Role");
  });
});
