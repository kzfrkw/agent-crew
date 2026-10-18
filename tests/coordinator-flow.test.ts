import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask, listEvents, listValidApprovals, setProjectSettingsRow } from "../src/db/store.ts";
import { latestNeedsInputReason, runUntilIdle } from "../src/orchestrator/engine.ts";
import { answerTask, approveTask, rejectTask } from "../src/orchestrator/human.ts";
import { taskDir } from "../src/orchestrator/paths.ts";
import { createPlanningTask, planningQuestions } from "../src/orchestrator/planning.ts";
import type { Config } from "../src/config/config.ts";
import { testContext } from "./helpers/context.ts";
import { tempDir } from "./helpers/gitrepo.ts";
import { approvedProject } from "./helpers/project.ts";
import { critic, planningScripts, rubricResults } from "./helpers/planning-scripts.ts";
import { ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";

/** フェーズ10-2(設計メモ v0.21・v0.22): 企画の流れをコーディネーターで動かす。守り(関門、ルーブリック、上限、記録)はコード */

type Move = Record<string, unknown>;
const mv = (verdict: string, o: Move = {}): Move => ({ verdict, summary: "s", role: null, input: null, question: null, gate: null, reason: "既定の進め方どおり", deviatesFromDefault: false, ...o });
const run = (role: string, input = `${role} への指示`) => mv("run_role", { role, input });
const gate = (g: string) => mv("request_approval", { gate: g });

/** 台本どおりに一手を返すコーディネーター。尽きたら人に聞く */
const coordinator =
  (moves: Move[]): Script =>
  (_spec, n) => ({ structuredOutput: moves[n] ?? mv("ask_human", { question: "台本が尽きました" }) });

const STRATEGY = [run("researcher"), run("critic"), run("strategist"), run("critic"), gate("strategy")];
const SCOPE = [run("product"), run("critic"), gate("scope")];
const HANDOFF = [run("ux"), run("critic"), run("handoff"), run("critic"), gate("handoff")];

async function setup(moves: Move[], over: Record<string, Script> = {}, o: { flow?: "coordinator" | "fixed"; config?: Partial<Config> } = {}) {
  const runner = new ScriptedRunner({ ...planningScripts(over), coordinator: coordinator(moves) });
  const ctx = testContext(runner, o.config);
  const { project } = await approvedProject(ctx);
  const docs = tempDir("agent-crew-docs-");
  writeFileSync(join(docs, "memo.md"), "社内の資料");
  const t = createPlanningTask(ctx, { projectName: "shop", title: "注文の状態を見せたい", body: "顧客が注文の状態を知りたい", docs: [docs], flow: o.flow ?? "coordinator" });
  return { ctx, t, runner, project };
}

const moves = (ctx: Awaited<ReturnType<typeof setup>>["ctx"], taskId: number) => listEvents(ctx.db, taskId, 2000).filter((e) => e.kind === "coordinator_move").map((e) => e.payload as Record<string, unknown>);

describe("切り替え", () => {
  it("既定は固定の流れ。プロジェクトでオンにすると、新しい企画のタスクはコーディネーターで動く", async () => {
    const runner = new ScriptedRunner({ ...planningScripts(), coordinator: coordinator(STRATEGY) });
    const ctx = testContext(runner);
    const { project } = await approvedProject(ctx);
    const docs = tempDir("agent-crew-docs-");
    const fixed = createPlanningTask(ctx, { projectName: "shop", title: "a", body: "b", docs: [docs] });
    expect(fixed.flow).toBe("fixed");
    setProjectSettingsRow(ctx.db, project.id, { coordinator: true });
    const coord = createPlanningTask(ctx, { projectName: "shop", title: "a", body: "b", docs: [docs] });
    expect(coord.flow).toBe("coordinator");
    // タスクごとの指定はプロジェクトの設定より優先する
    expect(createPlanningTask(ctx, { projectName: "shop", title: "a", body: "b", docs: [docs], flow: "fixed" }).flow).toBe("fixed");
  });

  it("コーディネーターのタスクは、開始すると coordinating になり、まずコーディネーターが起動する", async () => {
    const { ctx, t, runner } = await setup(STRATEGY);
    await runUntilIdle(ctx);
    expect(runner.rolesCalled()[0]).toBe("coordinator");
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_strategy_approval");
  });
});

describe("一周", () => {
  it("一手ずつ役割を動かし、承認の関門で止まる。承認するとコーディネーターに戻り、引き渡しの承認で開発のタスクを作る", async () => {
    const { ctx, t, runner } = await setup([...STRATEGY, ...SCOPE, ...HANDOFF]);
    await runUntilIdle(ctx);
    expect(runner.rolesCalled()).toEqual(["coordinator", "researcher", "coordinator", "critic", "coordinator", "strategist", "coordinator", "critic", "coordinator"]);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_strategy_approval");
    approveTask(ctx, t.id, "strategy");
    expect(getTask(ctx.db, t.id)!.state).toBe("coordinating");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_scope_approval");
    approveTask(ctx, t.id, "scope");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_handoff_approval");
    approveTask(ctx, t.id, "handoff", undefined, undefined, { targetProject: "shop" });
    expect(getTask(ctx.db, t.id)!.state).toBe("split");
  });

  it("書く役の入力には、企画の入力に加えてコーディネーターの指示が入る。批評は直前に書いた段を、その段のルーブリックで見る", async () => {
    const { ctx, runner } = await setup([run("researcher", "競合を3社に絞って調べる"), run("critic"), run("strategist"), run("critic")]);
    await runUntilIdle(ctx);
    const researcher = runner.calls.find((c) => c.role === "researcher")!;
    expect(researcher.prompt).toContain("顧客が注文の状態を知りたい");
    expect(researcher.prompt).toContain("競合を3社に絞って調べる");
    const [c1, c2] = runner.calls.filter((c) => c.role === "critic");
    expect(c1!.prompt).toContain("- [must] RS1:");
    expect(c2!.prompt).toContain("- [must] ST1:");
  });

  it("コーディネーターの入力に、使える役割(企画の役割だけ)、既定の進め方、今の承認とルーブリックの状況が入る", async () => {
    const { ctx, runner } = await setup([run("researcher"), run("critic")]);
    await runUntilIdle(ctx);
    const [first, , third] = runner.calls.filter((c) => c.role === "coordinator");
    expect(first!.prompt).toContain("strategist");
    expect(first!.prompt).not.toContain("implementer");
    expect(first!.prompt).toContain("既定の進め方");
    expect(third!.prompt).toMatch(/ルーブリック.*research/);
    // コーディネーターは読むだけ
    expect(first!.write).toBe("none");
  });
});

describe("画面", () => {
  it("タスクの要約に進め方と、最後に書いた段(パイプラインの現在地)を出す", async () => {
    const { ctx, t } = await setup([run("researcher"), run("critic"), run("strategist")]);
    const { taskSummaryOf } = await import("../src/server/api.ts");
    expect(taskSummaryOf(ctx.db, t.id)).toMatchObject({ flow: "coordinator", flowStage: null });
    await runUntilIdle(ctx);
    expect(taskSummaryOf(ctx.db, t.id)).toMatchObject({ flow: "coordinator", flowStage: "p_strategizing", stateLabel: "人の回答待ち" });
  });
});

describe("記録", () => {
  it("一手ごとに出来事と coordinator-log.md に残す(却下されたものも)", async () => {
    const { ctx, t } = await setup([run("product"), run("researcher")]);
    await runUntilIdle(ctx);
    const ms = moves(ctx, t.id);
    expect(ms[0]).toMatchObject({ ok: false, verdict: "run_role", role: "product" });
    expect(String(ms[0]!.rejection)).toMatch(/strategy/);
    expect(ms[1]).toMatchObject({ ok: true, verdict: "run_role", role: "researcher", reason: "既定の進め方どおり" });
    const log = readFileSync(join(taskDir(ctx.home, t.id), "coordinator-log.md"), "utf8");
    expect(log).toContain("product");
    expect(log).toContain("却下");
    expect(log).toContain("researcher");
  });
});

describe("守り", () => {
  it("却下された一手は、理由を添えてもう一度聞く。2回続けて却下されたら人の回答待ち", async () => {
    const { ctx, t, runner } = await setup([run("product"), run("implementer"), run("researcher")]);
    await runUntilIdle(ctx);
    const coords = runner.calls.filter((c) => c.role === "coordinator");
    expect(coords).toHaveLength(2);
    expect(coords[1]!.prompt).toContain("却下");
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "coordinating" });
    expect(latestNeedsInputReason(ctx.db, t.id)).toMatch(/却下/);
    // 回答するとコーディネーターに戻る
    answerTask(ctx, t.id, "調査から始めて");
    expect(getTask(ctx.db, t.id)!.state).toBe("coordinating");
  });

  it("ask_human は問いを理由にして人の回答待ちにする", async () => {
    const { ctx, t } = await setup([mv("ask_human", { question: "法人向けか個人向けか(推奨: 個人)" })]);
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "coordinating" });
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("法人向けか個人向けか");
  });

  it("書いていない段の批評は呼べない(却下として返す)", async () => {
    const { ctx, t } = await setup([run("critic"), run("researcher")]);
    await runUntilIdle(ctx);
    expect(moves(ctx, t.id)[0]).toMatchObject({ ok: false, role: "critic" });
  });

  it("承認済みの段を書き直したら、その段と後ろの段の承認を失効させる", async () => {
    const { ctx, t } = await setup([...STRATEGY, run("strategist")]);
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "strategy");
    expect(listValidApprovals(ctx.db, t.id).map((a) => a.kind)).toContain("strategy");
    await runUntilIdle(ctx);
    expect(listValidApprovals(ctx.db, t.id).map((a) => a.kind)).not.toContain("strategy");
  });

  it("ルーブリックの must が不合格のままでは、承認を求められない", async () => {
    const { ctx, t } = await setup([run("researcher"), run("critic"), run("strategist"), run("critic"), gate("strategy"), gate("strategy")], {
      critic: critic(["approve", "changes_requested"]),
    });
    await runUntilIdle(ctx);
    expect(moves(ctx, t.id).filter((m) => m.verdict === "request_approval").every((m) => m.ok === false)).toBe(true);
    expect(getTask(ctx.db, t.id)!.state).toBe("needs_input");
  });

  it("同じ理由の差し戻しが2回続いたら、上限を待たずに人に回す", async () => {
    const { ctx, t } = await setup([run("researcher"), run("critic"), run("researcher"), run("critic"), run("researcher")], { critic: critic(["changes_requested", "changes_requested"]) });
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "coordinating" });
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("同じ理由");
  });

  it("1タスクあたりの起動回数の上限に達したら、コーディネーターも起動せず人に回す", async () => {
    const { ctx, t, runner } = await setup([run("researcher"), run("critic"), run("researcher"), run("critic")], {}, { config: { limits: { maxRunsPerTask: 3 } as Config["limits"] } });
    await runUntilIdle(ctx);
    expect(runner.calls).toHaveLength(3);
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "coordinating" });
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("上限");
  });

  it("書く役の実行エラーは人の回答待ち", async () => {
    const { ctx, t } = await setup([run("researcher")], { researcher: () => ({ structuredOutput: { verdict: "ready", summary: "s" } }) });
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "coordinating" });
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("research.md");
  });
});

describe("人の承認", () => {
  it("却下するとコメントを残してコーディネーターに戻る", async () => {
    const { ctx, t, runner } = await setup([...STRATEGY, run("strategist")]);
    await runUntilIdle(ctx);
    rejectTask(ctx, t.id, "strategy", "ペルソナを1人に絞って");
    expect(getTask(ctx.db, t.id)!.state).toBe("coordinating");
    await runUntilIdle(ctx);
    const last = runner.calls.filter((c) => c.role === "coordinator").at(-2)!;
    expect(last.prompt).toContain("human-notes.md");
  });

  it("承認を求めた段で、書く役か批評担当が人の判断を求めていたら、問いと不合格の項目を承認に添える", async () => {
    const asks: Script = (spec, n) => {
      writeArtifact(spec, "critique.md", n === 1 ? "need_human" : "approve", "批評");
      return { structuredOutput: { verdict: n === 1 ? "need_human" : "approve", summary: "s", issues: [], questions: n === 1 ? ["対象を法人に絞るか"] : [], rubric: rubricResults(spec) } };
    };
    const { ctx, t } = await setup(STRATEGY, { critic: asks });
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_strategy_approval");
    expect(planningQuestions(ctx.db, t.id)).toMatchObject({ stage: "strategy", questions: [{ from: "批評担当", text: "対象を法人に絞るか" }] });
    expect(existsSync(join(taskDir(ctx.home, t.id), "coordinator-log.md"))).toBe(true);
  });
});
