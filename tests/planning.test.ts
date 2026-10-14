import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask, listChildren, listEvents, listTaskRepos } from "../src/db/store.ts";
import { runUntilIdle } from "../src/orchestrator/engine.ts";
import { approveTask, rejectTask } from "../src/orchestrator/human.ts";
import { nextActions } from "../src/orchestrator/next-actions.ts";
import { taskDir } from "../src/orchestrator/paths.ts";
import { createPlanningProject, createPlanningTask } from "../src/orchestrator/planning.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { testContext } from "./helpers/context.ts";
import { tempDir } from "./helpers/gitrepo.ts";
import { approvedProject } from "./helpers/project.ts";
import { answer, ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";

const write = (file: string): Script => answer(file, "ready", {});
const TICKETS = [
  { title: "注文に状態を持たせる", body: "API の各注文に status を含める", acceptanceCriteria: ["GET /api/orders の各注文に status がある"] },
  { title: "一覧に状態を表示する", body: "画面に状態の列を足す", acceptanceCriteria: ["一覧に状態の列がある"] },
];
const critic =
  (verdicts: string[] = []): Script =>
  (spec, n) => {
    const v = verdicts[n] ?? "approve";
    writeArtifact(spec, "critique.md", v, "批評");
    return { structuredOutput: { verdict: v, summary: "s", issues: v === "changes_requested" ? [{ severity: "must", title: "ペルソナが曖昧", detail: "d" }] : [] } };
  };
const scripts = (over: Record<string, Script> = {}): Record<string, Script> => ({
  researcher: write("research.md"),
  strategist: (spec, n) => {
    writeArtifact(spec, "strategy.slides.md", "ready");
    return write("strategy.md")(spec, n);
  },
  product: write("scope.md"),
  ux: (spec, n) => {
    writeArtifact(spec, "structure.md", "ready");
    return write("skeleton.md")(spec, n);
  },
  handoff: answer("handoff.md", "ready", { tickets: TICKETS }),
  critic: critic(),
  planner: answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false, design: { architect: false, designer: false, reason: "r" } }),
  ...over,
});

async function setup(over: Record<string, Script> = {}) {
  const runner = new ScriptedRunner(scripts(over));
  const ctx = testContext(runner);
  const { project } = await approvedProject(ctx);
  const docs = tempDir("agent-crew-docs-");
  writeFileSync(join(docs, "memo.md"), "社内の資料");
  const t = createPlanningTask(ctx, { projectName: "shop", title: "注文の状態を見せたい", body: "顧客が注文の状態を知りたい", docs: [docs] });
  return { ctx, t, runner, project, docs };
}

describe("企画の流れ(9a)", () => {
  it("調査 → 批評 → 戦略 → 批評 と進み、戦略の承認待ちで止まる。worktree は作らない", async () => {
    const { ctx, t, runner, docs } = await setup();
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_strategy_approval");
    expect(runner.rolesCalled()).toEqual(["researcher", "critic", "strategist", "critic"]);
    expect(listTaskRepos(ctx.db, t.id)).toEqual([]);
    const research = runner.calls.find((c) => c.role === "researcher")!;
    // 調査担当だけ Web を使える。Bash は使えない。書けるのは成果物ディレクトリだけ
    expect(research.tools).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]));
    expect(research.tools).not.toContain("Bash");
    expect(research.extraAllowedTools).toEqual(expect.arrayContaining(["WebSearch", "WebFetch"]));
    expect(research.write).toBe("artifacts");
    expect(research.cwd).toBe(taskDir(ctx.home, t.id));
    expect(research.prompt).toContain(docs);
    expect(research.prompt).toContain("顧客が注文の状態を知りたい");
    expect(runner.calls.find((c) => c.role === "strategist")!.tools).not.toContain("WebSearch");
    // 段の成果物は、役割の出力以外(スライドの Markdown など)も成果物として出す
    const { listArtifacts } = await import("../src/db/store.ts");
    expect(listArtifacts(ctx.db, t.id).map((a) => a.kind)).toEqual(expect.arrayContaining(["research", "strategy", "strategy.slides", "critique-research"]));
    // 批評は段ごとに残す
    expect(existsSync(join(taskDir(ctx.home, t.id), "critique-research.md"))).toBe(true);
    expect(runner.calls.filter((c) => c.role === "critic")[1]!.prompt).toContain("strategy.md");
  });

  it("批評が差し戻したら同じ段の書く役に戻り、書く役は批評を読む。同じ理由が続けば人に回す", async () => {
    const { ctx, t, runner } = await setup({ critic: critic(["changes_requested", "approve", "changes_requested", "changes_requested"]) });
    await runUntilIdle(ctx);
    expect(runner.rolesCalled().slice(0, 4)).toEqual(["researcher", "critic", "researcher", "critic"]);
    expect(runner.calls.filter((c) => c.role === "researcher")[1]!.prompt).toContain("critique-research.md");
    // 戦略で同じ指摘が2回続いた
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "p_strategizing" });
  });

  it("承認で要件 → 構造・骨格 → 引き渡しへ進む。却下は同じ段をやり直す", async () => {
    const { ctx, t, runner } = await setup();
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "strategy");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_scope_approval");
    rejectTask(ctx, t.id, "scope", "優先度を付けて");
    await runUntilIdle(ctx);
    expect(runner.calls.filter((c) => c.role === "product")).toHaveLength(2);
    expect(runner.calls.filter((c) => c.role === "product")[1]!.prompt).toContain("human-notes.md");
    approveTask(ctx, t.id, "scope");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_handoff_approval");
    expect(runner.rolesCalled().filter((r) => r !== "critic")).toEqual(["researcher", "strategist", "product", "product", "ux", "handoff"]);
    const acts = nextActions(ctx.db, getTask(ctx.db, t.id)!);
    expect(acts.find((a) => a.kind === "approve")!.command).toContain("--kind handoff");
  });

  it("引き渡しを承認すると、開発のタスクを順番つきで作り、企画は子の完了を待つ", async () => {
    const { ctx, t, project } = await setup();
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "strategy");
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "scope");
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "handoff");
    expect(getTask(ctx.db, t.id)!.state).toBe("split");
    const kids = listChildren(ctx.db, t.id);
    expect(kids.map((k) => [k.title, k.seq, k.projectId, k.kind])).toEqual([
      ["注文に状態を持たせる", 1, project.id, "normal"],
      ["一覧に状態を表示する", 2, project.id, "normal"],
    ]);
    expect(kids[0]!.body).toContain("GET /api/orders の各注文に status がある");
    expect(kids[0]!.body).toContain(join(taskDir(ctx.home, t.id), "scope.md"));
    // 1つ目の開発タスクは通常どおり計画から始まる
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, kids[0]!.id)!.state).toBe("awaiting_plan_approval");
    expect(getTask(ctx.db, kids[1]!.id)!.state).toBe("queued");
  });

  it("新サービス(リポジトリの無い企画用プロジェクト)では、引き渡し先のプロジェクトを指定する", async () => {
    const runner = new ScriptedRunner(scripts());
    const ctx = testContext(runner);
    const { project: dev } = await approvedProject(ctx);
    createPlanningProject(ctx, "newsvc");
    const t = createPlanningTask(ctx, { projectName: "newsvc", title: "新サービス", body: "b", docs: [] });
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "strategy");
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "scope");
    await runUntilIdle(ctx);
    expect(() => approveTask(ctx, t.id, "handoff")).toThrow(/引き渡し先/);
    // GUI では、リポジトリのあるプロジェクトから引き渡し先を選ぶ
    const approve = nextActions(ctx.db, getTask(ctx.db, t.id)!).find((a) => a.kind === "approve")!;
    expect(approve.targets).toEqual({ projects: ["shop"], selected: null });
    approveTask(ctx, t.id, "handoff", undefined, undefined, { targetProject: "shop" });
    expect(listChildren(ctx.db, t.id).every((k) => k.projectId === dev.id)).toBe(true);
    expect(listEvents(ctx.db, t.id, 200).some((e) => e.kind === "handed_off")).toBe(true);
  });

  it("読む資料が無い場所なら作れない", async () => {
    const ctx = testContext(new ScriptedRunner({}));
    await approvedProject(ctx);
    const missing = join(tempDir("agent-crew-x-"), "nope");
    expect(() => createPlanningTask(ctx, { projectName: "shop", title: "t", body: "b", docs: [missing] })).toThrow(/資料/);
    mkdirSync(missing);
  });
});

export type { RunSpec };

describe("批評が人の判断を求めたとき(9a。実機の通し確認で発見)", () => {
  it("次に人の承認がある段(戦略・要件・引き渡し)では止めずに承認待ちへ進み、問いを承認の理由に添える", async () => {
    const asks: Script = (spec, n) => {
      writeArtifact(spec, "critique.md", n === 1 ? "need_human" : "approve", "批評");
      return { structuredOutput: { verdict: n === 1 ? "need_human" : "approve", summary: n === 1 ? "API だけか画面も作るかは方針の選択" : "ok", issues: [] } };
    };
    const { ctx, t } = await setup({ critic: asks });
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_strategy_approval");
    const { taskSummaryOf } = await import("../src/server/api.ts");
    expect(taskSummaryOf(ctx.db, t.id)!.reason).toContain("API だけか画面も作るか");
  });

  it("書く役が人の判断を求めたときも、次に人の承認がある段なら承認待ちへ進む(批評は飛ばす)。却下して作り直すと問いは消える", async () => {
    let n = 0;
    const product: Script = (spec) => {
      writeArtifact(spec, "scope.slides.md", "ready");
      const v = n++ === 0 ? "need_human" : "ready";
      writeArtifact(spec, "scope.md", v, "要件");
      return { structuredOutput: { verdict: v, summary: v === "need_human" ? "画面を作るか API だけかを選んでください" : "s" } };
    };
    const { ctx, t, runner } = await setup({ product });
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "strategy");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_scope_approval");
    const { taskSummaryOf } = await import("../src/server/api.ts");
    expect(taskSummaryOf(ctx.db, t.id)!.reason).toContain("画面を作るか API だけか");
    expect(runner.rolesCalled().filter((r) => r === "critic")).toHaveLength(2); // 調査・戦略だけ
    rejectTask(ctx, t.id, "scope", "画面も作る");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_scope_approval");
    expect(taskSummaryOf(ctx.db, t.id)!.reason).toBeNull();
  });

  it("人の承認が無い段(調査、構造・骨格)では、従来どおり人の回答待ちにする", async () => {
    const asks: Script = (spec) => {
      writeArtifact(spec, "critique.md", "need_human", "批評");
      return { structuredOutput: { verdict: "need_human", summary: "調べる範囲を決めて", issues: [] } };
    };
    const { ctx, t } = await setup({ critic: asks });
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "p_researching" });
  });
});
