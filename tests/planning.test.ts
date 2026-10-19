import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectByName, getTask, listChildren, listEvents, listRepos, listTaskRepos } from "../src/db/store.ts";
import { runUntilIdle } from "../src/orchestrator/engine.ts";
import { approveTask, rejectTask } from "../src/orchestrator/human.ts";
import { nextActions } from "../src/orchestrator/next-actions.ts";
import { taskDir } from "../src/orchestrator/paths.ts";
import { createPlanningProject, createPlanningTask } from "../src/orchestrator/planning.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { testContext } from "./helpers/context.ts";
import { git, makeRepo, tempDir } from "./helpers/gitrepo.ts";
import { approvedProject, PROFILE } from "./helpers/project.ts";
import { approveProfile, reprofileProject } from "../src/orchestrator/projects.ts";
import { answer, ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";
import { critic, planningScripts as scripts, rubricResults, TICKETS } from "./helpers/planning-scripts.ts";

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
    expect(approve.targets).toEqual({ projects: ["shop"], selected: null, attachTo: "newsvc" });
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
      return {
        structuredOutput: {
          verdict: n === 1 ? "need_human" : "approve",
          summary: n === 1 ? "方針の選択が2つある" : "ok",
          issues: n === 1 ? [{ severity: "should", title: "指標の基準が無い", detail: "d" }] : [],
          questions: n === 1 ? ["API だけか、画面も作るか(推奨: 画面も)", "見せる相手を社内だけにするか"] : [],
          rubric: rubricResults(spec),
        },
      };
    };
    const { ctx, t } = await setup({ critic: asks });
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_strategy_approval");
    const { taskSummaryOf } = await import("../src/server/api.ts");
    // ダッシュボードの理由は短く(件数)、中身は問いごとに分けて持つ
    expect(taskSummaryOf(ctx.db, t.id)!.reason).toBe("人の判断が要る点が 2 件あります(承認のコメントで答えてください)");
    const { planningQuestions } = await import("../src/orchestrator/planning.ts");
    expect(planningQuestions(ctx.db, t.id)).toEqual({
      stage: "strategy",
      questions: [
        { from: "批評担当", text: "API だけか、画面も作るか(推奨: 画面も)" },
        { from: "批評担当", text: "見せる相手を社内だけにするか" },
      ],
      musts: [],
      shoulds: 1,
    });
  });

  it("書く役が人の判断を求めたときも、次に人の承認がある段なら承認待ちへ進む(批評は動くが差し戻さない)。却下して作り直すと問いは消える", async () => {
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
    // 問いを分けて返さなかったときは、要約を1件の問いとして扱う
    expect(taskSummaryOf(ctx.db, t.id)!.reason).toContain("1 件");
    const { planningQuestions } = await import("../src/orchestrator/planning.ts");
    // 誰からの問いかは、段の担当名で出す(要件の段なら要件担当)
    expect(planningQuestions(ctx.db, t.id)!.questions).toEqual([{ from: "要件担当", text: "画面を作るか API だけかを選んでください" }]);
    expect(runner.rolesCalled().filter((r) => r === "critic")).toHaveLength(3); // 書く役が問いを出しても批評は動く(差し戻しはしない)
    rejectTask(ctx, t.id, "scope", "画面も作る");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_scope_approval");
    expect(taskSummaryOf(ctx.db, t.id)!.reason).toBeNull();
    expect(planningQuestions(ctx.db, t.id)).toBeNull();
  });

  it("人の承認が無い段(調査、構造・骨格)では、従来どおり人の回答待ちにする", async () => {
    const asks: Script = (spec) => {
      writeArtifact(spec, "critique.md", "need_human", "批評");
      return { structuredOutput: { verdict: "need_human", summary: "調べる範囲を決めて", issues: [], rubric: rubricResults(spec) } };
    };
    const { ctx, t } = await setup({ critic: asks });
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "p_researching" });
  });
});

describe("ルーブリック(10-1b。設計メモ v0.22)", () => {
  it("批評担当の入力に段のルーブリックの項目が並び、書く役の入力にもルーブリックの場所がある", async () => {
    const { ctx, runner } = await setup();
    await runUntilIdle(ctx);
    const [c1, c2] = runner.calls.filter((c) => c.role === "critic");
    expect(c1!.prompt).toContain("- [must] RS1:");
    expect(c1!.prompt).not.toContain("ST1");
    expect(c2!.prompt).toContain("- [must] ST1:");
    expect(runner.calls.find((c) => c.role === "researcher")!.prompt).toContain(join("rubrics", "planning-research.md"));
  });

  it("項目ごとの結果を出来事に残す(不合格の must と should、初回か)", async () => {
    const { ctx, t } = await setup({ critic: critic(["changes_requested", "approve"]) });
    await runUntilIdle(ctx);
    const evs = listEvents(ctx.db, t.id).filter((e) => e.kind === "rubric").map((e) => e.payload as Record<string, unknown>);
    expect(evs[0]).toMatchObject({ stage: "research", rubric: "planning-research", verdict: "changes_requested", mustFailed: ["RS1"], shouldFailed: [], attempt: 1 });
    expect(evs[1]).toMatchObject({ stage: "research", verdict: "approve", mustFailed: [], attempt: 2 });
    expect((evs[0]!.results as unknown[]).length).toBeGreaterThan(0);
  });

  it("引き渡しの批評には、開発のタスクになるチケット(まとめ担当の構造化出力)を、受け入れ条件つきで渡す(10-3: handoff.md だけでは HO2・HO3 を確かめられなかった)", async () => {
    const { ctx, t, runner } = await setup();
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "strategy");
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "scope");
    await runUntilIdle(ctx);
    const last = runner.calls.filter((c) => c.role === "critic").at(-1)!;
    expect(last.prompt).toContain("- [must] HO1:");
    expect(last.prompt).toContain("注文に状態を持たせる");
    expect(last.prompt).toContain("GET /api/orders の各注文に status がある");
    // ほかの段の批評には出さない
    expect(runner.calls.filter((c) => c.role === "critic")[0]!.prompt).not.toContain("注文に状態を持たせる");
  });

  it("差し戻しの理由の要点は、不合格の must の ID", async () => {
    const { ctx, t } = await setup({ critic: critic(["changes_requested", "approve"]) });
    await runUntilIdle(ctx);
    const b = listEvents(ctx.db, t.id).find((e) => e.kind === "bounce")!.payload as { key: string; summary: string };
    expect(b.key).toBe("research:RS1");
    expect(b.summary).toContain("RS1");
  });

  it("判定と項目ごとの結果が食い違えば(must の不合格があるのに approve)、推測で進めずに人に回す", async () => {
    const liar: Script = (spec) => {
      writeArtifact(spec, "critique.md", "approve", "批評");
      return { structuredOutput: { verdict: "approve", summary: "s", issues: [], rubric: rubricResults(spec, true) } };
    };
    const { ctx, t } = await setup({ critic: liar });
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "p_researching" });
    const { latestNeedsInputReason } = await import("../src/orchestrator/engine.ts");
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("RS1");
  });

  it("人の承認がある段で must が不合格のまま人の判断を求めたら、不合格の項目を承認の理由に添える", async () => {
    const asks: Script = (spec, n) => {
      writeArtifact(spec, "critique.md", n === 1 ? "need_human" : "approve", "批評");
      return { structuredOutput: { verdict: n === 1 ? "need_human" : "approve", summary: "s", issues: [], questions: n === 1 ? ["対象を法人に絞るか"] : [], rubric: rubricResults(spec, n === 1) } };
    };
    const { ctx, t } = await setup({ critic: asks });
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_strategy_approval");
    const { planningQuestions } = await import("../src/orchestrator/planning.ts");
    expect(planningQuestions(ctx.db, t.id)!.musts).toEqual([expect.stringMatching(/^ST1: /)]);
  });
});

describe("引き渡しで開発のプロジェクトを用意する(9a。新サービス)", () => {
  /** リポジトリの無い企画用プロジェクトで、引き渡しの承認待ちまで進める */
  async function planned() {
    const runner = new ScriptedRunner(scripts());
    const ctx = testContext(runner);
    createPlanningProject(ctx, "newsvc");
    const t = createPlanningTask(ctx, { projectName: "newsvc", title: "新サービス", body: "b", docs: [] });
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "strategy");
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "scope");
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_handoff_approval");
    return { ctx, t };
  }

  it("GUI では、企画のプロジェクトにリポジトリを足すか、別のプロジェクトを作るかも選べる", async () => {
    const { ctx, t } = await planned();
    const approve = nextActions(ctx.db, getTask(ctx.db, t.id)!).find((a) => a.kind === "approve")!;
    expect(approve.targets).toEqual({ projects: [], selected: null, attachTo: "newsvc" });
  });

  it("空のフォルダ(無ければ作る)を指定すると git init して企画のプロジェクトに登録し、開発のタスクを作る。プロファイルは承認待ちになるまで始めない", async () => {
    const { ctx, t } = await planned();
    const dir = join(tempDir("agent-crew-new-"), "newsvc-app");
    approveTask(ctx, t.id, "handoff", undefined, undefined, { devProject: { repoPath: dir } });
    const project = getProjectByName(ctx.db, "newsvc")!;
    const repos = listRepos(ctx.db, project.id);
    expect(repos.map((r) => [r.path, r.role, r.defaultBranch])).toEqual([[realpathSync(dir), "newsvc-app", "main"]]);
    expect(git(dir, "log", "--oneline")).toMatch(/\S/);
    expect(listChildren(ctx.db, t.id).every((k) => k.projectId === project.id)).toBe(true);
    expect(project.profileStatus).toBe("none");
    // プロファイルを作って承認するまで、開発のタスクは始まらない
    ctx.runner = new ScriptedRunner({
      profiler: (spec) => {
        writeArtifact(spec, "profile.md", "ready");
        return { structuredOutput: { verdict: "ready", summary: "s", profile: { ...PROFILE, testInfra: "none" } } };
      },
      planner: scripts().planner!,
    });
    await runUntilIdle(ctx);
    expect(listChildren(ctx.db, t.id).map((k) => k.state)).toEqual(["queued", "queued"]);
    const r = await reprofileProject(ctx, "newsvc");
    expect(r.ok).toBe(true);
    approveProfile(ctx, "newsvc", { allowWithoutTests: true });
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, listChildren(ctx.db, t.id)[0]!.id)!.state).toBe("awaiting_plan_approval");
  });

  it("名前を付けると、別のプロジェクトを作ってそこに引き渡す(手元の既存のリポジトリも使える)", async () => {
    const { ctx, t } = await planned();
    const { repo } = makeRepo();
    approveTask(ctx, t.id, "handoff", undefined, undefined, { devProject: { repoPath: repo, name: "newsvc-dev" } });
    const dev = getProjectByName(ctx.db, "newsvc-dev")!;
    expect(listRepos(ctx.db, dev.id).map((r) => r.path)).toEqual([realpathSync(repo)]);
    expect(listRepos(ctx.db, getProjectByName(ctx.db, "newsvc")!.id)).toEqual([]);
    expect(listChildren(ctx.db, t.id).every((k) => k.projectId === dev.id)).toBe(true);
  });

  it("空でない git 以外のフォルダや、使われている名前では、何も変えずにエラー", async () => {
    const { ctx, t } = await planned();
    const dir = tempDir("agent-crew-x-");
    writeFileSync(join(dir, "a.txt"), "x");
    expect(() => approveTask(ctx, t.id, "handoff", undefined, undefined, { devProject: { repoPath: dir } })).toThrow(/空のフォルダか git リポジトリ/);
    expect(() => approveTask(ctx, t.id, "handoff", undefined, undefined, { devProject: { repoPath: "relative" } })).toThrow(/絶対パス/);
    const { repo } = makeRepo();
    expect(() => approveTask(ctx, t.id, "handoff", undefined, undefined, { devProject: { repoPath: repo, name: "newsvc" } })).toThrow(/すでに/);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_handoff_approval");
    expect(listChildren(ctx.db, t.id)).toEqual([]);
    expect(listRepos(ctx.db, getProjectByName(ctx.db, "newsvc")!.id)).toEqual([]);
  });
});
