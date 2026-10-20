import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/connection.ts";
import { addApproval, addEvent, createProject, createTask, finishRun, startRun, updateTaskState } from "../src/db/store.ts";
import { classifyStop, collectStats, formatStats } from "../src/orchestrator/stats.ts";

/**
 * 実際の使用での詰まりの集計(設計メモ v0.26 の 4、26-2)。止まった理由を、環境・ツールが原因のものと判断が要ったものに分け、
 * 人の介入、差し戻し、待ち、役割ごとの時間と費用、週ごとの費用、タスクの大きさごとの所要時間を出す。スキーマは増やさない
 */

describe("classifyStop(止まった理由の分類)", () => {
  it("環境・ツールが原因のもの(通信、サンドボックス、ビルド・撮影の実行の失敗、ブラウザが起動できない)", () => {
    expect(classifyStop({ event: "run_error", reason: "画面を撮影できませんでした: flutter drive が失敗しました(終了コード 69): Failed host lookup: 'pub.dev'" })).toBe("env");
    // 役割の判定(need_human / blocked)でも、理由が環境なら環境に数える(実際の記録で多い)
    expect(classifyStop({ event: "verdict", verdict: "need_human", reason: "qa の判定: need_human — サンドボックスで headless Chrome が動かず、条件9は確認できていない" })).toBe("env");
    expect(classifyStop({ reason: "implementer の判定: blocked — `flutter pub get` が pub.dev への TLS 接続に失敗するため" })).toBe("env");
    expect(classifyStop({ reason: "npm test の失敗6件は、サンドボックスの中で sandbox-exec を入れ子で使えないために起こります" })).toBe("env");
  });

  it("判断が要ったもの(役割やコーディネーターが人に聞いた)", () => {
    expect(classifyStop({ event: "verdict", verdict: "need_human", reason: "planner の判定: need_human — 在庫0を一覧から除くかを決めてください" })).toBe("judgment");
    expect(classifyStop({ event: "ask_human", reason: "コーディネーターの問い: 法人向けか個人向けか" })).toBe("judgment");
  });

  it("役割の出力の不備、main への追従、上限、同じ理由の繰り返し、人が止めた", () => {
    expect(classifyStop({ event: "run_error", reason: "qa: 成果物 qa-report.md が今回の実行で書かれていません" })).toBe("output");
    expect(classifyStop({ event: "run_error", reason: "critic: ルーブリック planning-research: approve ですが、must の項目 RS1 が不合格です" })).toBe("output");
    // 決まりの不履行(撮影のテストを書いていない、done なのにコミットが無い)は、環境ではなく役割の出力の不備(実データで見つけた)
    expect(classifyStop({ reason: "画面を撮影できませんでした: integration_test/screens_test.dart がありません(画面を開いて takeScreenshot(<画面の名前>) するテストを、実装者が書く決まりです)" })).toBe("output");
    expect(classifyStop({ event: "run_error", reason: "implementer: done と判定しましたが、コミットがありません" })).toBe("output");
    expect(classifyStop({ event: "run_error", reason: "ベース(main)が進んでいます。agent-crew task update-base 7 で追従してください" })).toBe("base");
    expect(classifyStop({ reason: "base_updated" })).toBe("base");
    expect(classifyStop({ event: "limit_exceeded", reason: "役割の起動回数が上限(60 回)に達しました" })).toBe("limit");
    expect(classifyStop({ event: "repeated_failure", reason: "同じ理由で2回差し戻されました" })).toBe("repeated");
    expect(classifyStop({ event: "stopped", reason: "人が停止しました" })).toBe("stopped");
    expect(classifyStop({ reason: "よく分からない理由" })).toBe("other");
  });
});

function fixture() {
  const db = openDb(":memory:");
  const p = createProject(db, { name: "app" });
  const other = createProject(db, { name: "other" });
  const t1 = createTask(db, { projectId: p.id, title: "a", body: "" });
  const t2 = createTask(db, { projectId: p.id, title: "b", body: "" });
  const t3 = createTask(db, { projectId: other.id, title: "c", body: "" });
  // 止まった理由
  addEvent(db, { taskId: t1.id, kind: "needs_input", payload: { event: "run_error", reason: "画面を撮影できませんでした: flutter drive が失敗しました(終了コード 69): Failed host lookup: 'pub.dev'" } });
  addEvent(db, { taskId: t1.id, kind: "needs_input", payload: { event: "run_error", reason: "画面を撮影できませんでした: flutter drive が失敗しました(終了コード 69): Failed host lookup: 'pub.dev'" } });
  addEvent(db, { taskId: t2.id, kind: "needs_input", payload: { event: "verdict", role: "planner", verdict: "need_human", reason: "planner の判定: need_human — 範囲を決めてください" } });
  addEvent(db, { taskId: t2.id, kind: "failed", payload: { event: "fail", reason: "worktree を作れません" } });
  addEvent(db, { taskId: t3.id, kind: "needs_input", payload: { event: "stopped", reason: "人が停止しました" } });
  // 人の介入
  addEvent(db, { taskId: t1.id, kind: "state_changed", payload: { from: "needs_input", to: "qa", event: "answer" } });
  addEvent(db, { taskId: t1.id, kind: "state_changed", payload: { from: "qa", to: "human_working", event: "takeover" } });
  addApproval(db, { taskId: t1.id, kind: "final", result: "rejected", comment: "直して" });
  addApproval(db, { taskId: t1.id, kind: "plan", result: "approved", comment: "この方針で" });
  addApproval(db, { taskId: t2.id, kind: "plan", result: "approved" });
  // 差し戻しと待ち
  addEvent(db, { taskId: t1.id, kind: "bounce", payload: { source: "review", key: "k", summary: "s" } });
  addEvent(db, { taskId: t2.id, kind: "bounce", payload: { source: "tests", key: "k", summary: "s" } });
  addEvent(db, { taskId: t2.id, kind: "waiting_repo", payload: { message: "m" } });
  // 実行(役割ごとの時間と費用)
  for (const [taskId, role, cost] of [[t1.id, "implementer", 0.5], [t1.id, "reviewer", 0.25], [t2.id, "implementer", 0.75], [t3.id, "implementer", 9]] as const) {
    const r = startRun(db, { taskId, role });
    finishRun(db, r.id, { state: "succeeded", costUsd: cost });
  }
  // 大きさと完了
  addEvent(db, { taskId: t1.id, kind: "plan", payload: { size: "small" } });
  updateTaskState(db, t1.id, { state: "done", heldFromState: null, assignee: null, reviewRounds: 0, design: { architect: false, designer: false } });
  addEvent(db, { taskId: t1.id, kind: "state_changed", payload: { from: "integrating", to: "done", event: "verdict" } });
  return { db, p, other, t1, t2, t3 };
}

describe("collectStats", () => {
  it("プロジェクトで絞り、止まった理由を分類ごとに、文面の件数つきで出す", () => {
    const { db, p } = fixture();
    const s = collectStats(db, { projectId: p.id });
    expect(s.stops.total).toBe(4);
    const env = s.stops.byCategory.find((c) => c.category === "env")!;
    expect(env.count).toBe(2);
    expect(env.examples[0]).toMatchObject({ count: 2 });
    expect(env.examples[0]!.text).toContain("flutter drive が失敗しました");
    expect(s.stops.byCategory.find((c) => c.category === "judgment")!.count).toBe(1);
    // 別のプロジェクトの停止は数えない
    expect(s.stops.byCategory.find((c) => c.category === "stopped")).toBeUndefined();
  });

  it("人の介入(回答・引き取り・却下・コメントつきの承認)、差し戻し、待ちを数える", () => {
    const { db, p } = fixture();
    const s = collectStats(db, { projectId: p.id });
    const iv = Object.fromEntries(s.interventions.map((x) => [x.kind, x.count]));
    expect(iv).toMatchObject({ answer: 1, takeover: 1, reject: 1, approve_comment: 1 });
    expect(Object.fromEntries(s.bounces.map((x) => [x.source, x.count]))).toEqual({ review: 1, tests: 1 });
    expect(Object.fromEntries(s.waits.map((x) => [x.kind, x.count]))).toEqual({ waiting_repo: 1 });
  });

  it("役割ごとの回数と費用、週ごとの費用、大きさごとの完了したタスクを出す", () => {
    const { db, p } = fixture();
    const s = collectStats(db, { projectId: p.id });
    expect(s.roles.find((r) => r.role === "implementer")).toMatchObject({ runs: 2, costUsd: 1.25 });
    expect(s.weeks).toHaveLength(1);
    expect(s.weeks[0]!.costUsd).toBeCloseTo(1.5);
    expect(s.weeks[0]!.week).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.bySize).toEqual([expect.objectContaining({ size: "small", tasks: 1, medianCostUsd: 0.75 })]);
    expect(s.tasks).toMatchObject({ total: 2, done: 1 });
  });

  it("全体と、期間の絞り込み(since より前の記録は数えない)", () => {
    const { db } = fixture();
    expect(collectStats(db, {}).stops.total).toBe(5);
    const later = collectStats(db, { since: "2999-01-01" });
    expect(later.stops.total).toBe(0);
    expect(later.roles).toEqual([]);
  });

  it("文面にまとめて出す(分類ごとの件数と割合、例、介入、役割、週)", () => {
    const { db, p } = fixture();
    const text = formatStats(collectStats(db, { projectId: p.id }), { projectName: "app" });
    expect(text).toContain("止まった理由");
    expect(text).toMatch(/環境・ツール\s+2 件\(50%\)/);
    expect(text).toContain("flutter drive が失敗しました");
    expect(text).toContain("人の介入");
    expect(text).toContain("implementer");
    expect(text).toContain("週ごとの費用");
  });
});
