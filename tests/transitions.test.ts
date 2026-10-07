import { describe, expect, it } from "vitest";
import {
  transition,
  roleForState,
  TransitionError,
  type TaskSnapshot,
  type TaskEvent,
  type TransitionContext,
} from "../src/orchestrator/transitions.ts";
import type { TaskState } from "../src/orchestrator/states.ts";

const ctx = (over: Partial<TransitionContext> = {}): TransitionContext => ({
  maxReviewRounds: 3,
  runActive: false,
  testGateOpen: true,
  ...over,
});
const snap = (state: TaskState, over: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  state,
  heldFromState: null,
  reviewRounds: 0,
  ...over,
});
const next = (s: TaskSnapshot, e: TaskEvent, c = ctx()) => transition(s, e, c);

describe("正常系の一周", () => {
  const cases: [TaskState, TaskEvent, TaskState][] = [
    ["queued", { type: "start" }, "planning"],
    ["planning", { type: "verdict", role: "planner", verdict: "ready" }, "awaiting_plan_approval"],
    ["awaiting_plan_approval", { type: "approve", kind: "plan" }, "implementing"],
    ["implementing", { type: "verdict", role: "implementer", verdict: "done" }, "reviewing"],
    ["reviewing", { type: "verdict", role: "reviewer", verdict: "approve" }, "qa"],
    ["qa", { type: "verdict", role: "qa", verdict: "passed" }, "awaiting_final_approval"],
    ["awaiting_final_approval", { type: "approve", kind: "final" }, "integrating"],
    ["integrating", { type: "verdict", role: "integrator", verdict: "done" }, "done"],
  ];
  it.each(cases)("%s --%j--> %s", (from, event, to) => {
    expect(next(snap(from), event).state).toBe(to);
  });

  it("エージェントが動く状態では担当が agent、承認待ちでは null", () => {
    expect(next(snap("queued"), { type: "start" }).assignee).toBe("agent");
    expect(next(snap("planning"), { type: "verdict", role: "planner", verdict: "ready" }).assignee).toBeNull();
  });
});

describe("役割と状態の対応", () => {
  it("roleForState", () => {
    expect(roleForState("planning")).toBe("planner");
    expect(roleForState("implementing")).toBe("implementer");
    expect(roleForState("reviewing")).toBe("reviewer");
    expect(roleForState("qa")).toBe("qa");
    expect(roleForState("integrating")).toBe("integrator");
    expect(roleForState("awaiting_plan_approval")).toBeNull();
  });

  it("状態と合わない役割の判定は拒否する", () => {
    expect(() => next(snap("planning"), { type: "verdict", role: "reviewer", verdict: "approve" })).toThrow(TransitionError);
  });

  it("役割が返せない判定は拒否する", () => {
    expect(() => next(snap("planning"), { type: "verdict", role: "planner", verdict: "approve" })).toThrow(TransitionError);
  });
});

describe("差し戻しと上限", () => {
  it("changes_requested は implementing に戻り、回数が増える", () => {
    const r = next(snap("reviewing", { reviewRounds: 1 }), { type: "verdict", role: "reviewer", verdict: "changes_requested" });
    expect(r).toMatchObject({ state: "implementing", reviewRounds: 2 });
  });

  it("QAの failed と、オーケストレーターのテスト失敗も差し戻しとして数える", () => {
    expect(next(snap("qa"), { type: "verdict", role: "qa", verdict: "failed" })).toMatchObject({ state: "implementing", reviewRounds: 1 });
    expect(next(snap("reviewing"), { type: "tests_failed" })).toMatchObject({ state: "implementing", reviewRounds: 1 });
  });

  it("3回を超える差し戻しは needs_input(再開先は implementing)", () => {
    const r = next(snap("reviewing", { reviewRounds: 3 }), { type: "verdict", role: "reviewer", verdict: "changes_requested" });
    expect(r).toMatchObject({ state: "needs_input", heldFromState: "implementing", reviewRounds: 4 });
  });

  it("回答で再開すると回数は0に戻る", () => {
    const r = next(snap("needs_input", { heldFromState: "implementing", reviewRounds: 4 }), { type: "answer" });
    expect(r).toMatchObject({ state: "implementing", heldFromState: null, reviewRounds: 0 });
  });
});

describe("need_human と blocked", () => {
  const cases: [TaskState, TaskEvent][] = [
    ["planning", { type: "verdict", role: "planner", verdict: "need_human" }],
    ["implementing", { type: "verdict", role: "implementer", verdict: "blocked" }],
    ["implementing", { type: "verdict", role: "implementer", verdict: "need_human" }],
    ["reviewing", { type: "verdict", role: "reviewer", verdict: "need_human" }],
    ["qa", { type: "verdict", role: "qa", verdict: "need_human" }],
    ["integrating", { type: "verdict", role: "integrator", verdict: "blocked" }],
  ];
  it.each(cases)("%s で %j なら needs_input になり、元の状態を覚える", (from, event) => {
    expect(next(snap(from), event)).toMatchObject({ state: "needs_input", heldFromState: from });
  });

  it("上限超え(時間・予算)も needs_input", () => {
    expect(next(snap("implementing"), { type: "limit_exceeded", reason: "timeout" })).toMatchObject({
      state: "needs_input",
      heldFromState: "implementing",
    });
  });

  it("役割の実行エラー(成果物が無い、判定が不正など)も needs_input", () => {
    expect(next(snap("reviewing"), { type: "run_error", reason: "成果物がない" })).toMatchObject({
      state: "needs_input",
      heldFromState: "reviewing",
    });
  });

  it("needs_input 以外で answer は拒否", () => {
    expect(() => next(snap("planning"), { type: "answer" })).toThrow(TransitionError);
  });
});

describe("人の承認・却下", () => {
  it("計画の却下はプランナーに戻す", () => {
    expect(next(snap("awaiting_plan_approval"), { type: "reject", kind: "plan" }).state).toBe("planning");
  });
  it("最終確認の却下は実装に戻す(差し戻し回数には数えない)", () => {
    expect(next(snap("awaiting_final_approval", { reviewRounds: 2 }), { type: "reject", kind: "final" })).toMatchObject({
      state: "implementing",
      reviewRounds: 2,
    });
  });
  it("承認待ちでない状態の承認は拒否", () => {
    expect(() => next(snap("implementing"), { type: "approve", kind: "plan" })).toThrow(TransitionError);
    expect(() => next(snap("awaiting_plan_approval"), { type: "approve", kind: "final" })).toThrow(TransitionError);
  });
});

describe("人への引き継ぎ(human_working)", () => {
  it("引き取ると human_working になり、元の状態を覚える。担当は human", () => {
    expect(next(snap("reviewing"), { type: "takeover" })).toMatchObject({
      state: "human_working",
      heldFromState: "reviewing",
      assignee: "human",
    });
  });

  it("needs_input から引き取ると、needs_input の前の状態を覚える", () => {
    expect(next(snap("needs_input", { heldFromState: "implementing" }), { type: "takeover" }).heldFromState).toBe("implementing");
  });

  it("エージェント実行中は引き取れない(先に止める)", () => {
    expect(() => next(snap("implementing"), { type: "takeover" }, ctx({ runActive: true }))).toThrow(/実行中/);
  });

  it("human_working の間は、エージェントにつながる出来事を拒否する", () => {
    const s = snap("human_working", { heldFromState: "implementing" });
    for (const e of [
      { type: "start" },
      { type: "verdict", role: "implementer", verdict: "done" },
      { type: "answer" },
      { type: "approve", kind: "final" },
      { type: "tests_failed" },
    ] as TaskEvent[]) {
      expect(() => next(s, e)).toThrow(TransitionError);
    }
  });

  it("変更なしで戻すと、元の状態に戻る", () => {
    const r = next(snap("human_working", { heldFromState: "implementing" }), { type: "return", humanChanged: false });
    expect(r).toMatchObject({ state: "implementing", heldFromState: null, assignee: "agent", effects: [] });
  });

  it("人が変更して戻すと、レビューからやり直し、レビュー・QA・最終確認の承認を失効させる", () => {
    for (const from of ["implementing", "reviewing", "qa", "awaiting_final_approval", "integrating"] as TaskState[]) {
      const r = next(snap("human_working", { heldFromState: from, reviewRounds: 2 }), { type: "return", humanChanged: true });
      expect(r).toMatchObject({ state: "reviewing", reviewRounds: 0 });
      expect(r.effects).toEqual([{ type: "invalidate_approvals", kinds: ["review", "qa", "final"] }]);
    }
  });

  it("実装前の段階で人が変更して戻した場合は、元の状態に戻る(レビューする実装がまだ無い)", () => {
    const r = next(snap("human_working", { heldFromState: "awaiting_plan_approval" }), { type: "return", humanChanged: true });
    expect(r.state).toBe("awaiting_plan_approval");
  });

  it("human_working 以外で return は拒否", () => {
    expect(() => next(snap("implementing"), { type: "return", humanChanged: false })).toThrow(TransitionError);
  });
});

describe("ベース更新", () => {
  it("実装以降の段階でベースを取り込んだら、レビューからやり直す(承認を失効)", () => {
    for (const from of ["reviewing", "qa", "awaiting_final_approval", "integrating"] as TaskState[]) {
      const r = next(snap(from), { type: "base_updated" });
      expect(r).toMatchObject({ state: "reviewing" });
      expect(r.effects).toEqual([{ type: "invalidate_approvals", kinds: ["review", "qa", "final"] }]);
    }
  });
  it("needs_input(実装以降から)でも同じ", () => {
    expect(next(snap("needs_input", { heldFromState: "integrating" }), { type: "base_updated" }).state).toBe("reviewing");
  });
  it("実装前・実装中は状態を変えない", () => {
    for (const from of ["planning", "awaiting_plan_approval", "implementing"] as TaskState[]) {
      expect(next(snap(from), { type: "base_updated" })).toMatchObject({ state: from, effects: [] });
    }
  });
  it("衝突したら needs_input", () => {
    expect(next(snap("awaiting_final_approval"), { type: "base_conflict", reason: "x" })).toMatchObject({ state: "needs_input", heldFromState: "awaiting_final_approval" });
  });
  it("人が作業中は受け付けない", () => {
    expect(() => next(snap("human_working", { heldFromState: "qa" }), { type: "base_updated" })).toThrow(TransitionError);
  });
});

describe("テスト基盤のゲート", () => {
  it("テスト基盤が整うまで、通常タスクは開始できない", () => {
    expect(() => next(snap("queued"), { type: "start" }, ctx({ testGateOpen: false }))).toThrow(/テスト基盤/);
  });
});

describe("終了・失敗・取り消し", () => {
  it("どの進行中の状態からでも cancel と fail ができる", () => {
    for (const s of ["queued", "planning", "awaiting_plan_approval", "implementing", "needs_input", "human_working"] as TaskState[]) {
      expect(next(snap(s), { type: "cancel" }).state).toBe("cancelled");
      expect(next(snap(s), { type: "fail", reason: "x" })).toMatchObject({ state: "failed", heldFromState: s });
    }
  });

  it("failed から retry すると、失敗した状態からやり直す", () => {
    expect(next(snap("failed", { heldFromState: "qa" }), { type: "retry" }).state).toBe("qa");
  });

  it("done と cancelled からは何もできない", () => {
    for (const s of ["done", "cancelled"] as TaskState[]) {
      expect(() => next(snap(s), { type: "cancel" })).toThrow(TransitionError);
      expect(() => next(snap(s), { type: "start" })).toThrow(TransitionError);
    }
  });
});
