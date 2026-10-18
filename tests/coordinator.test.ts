import { describe, expect, it } from "vitest";
import { loadRoles } from "../src/roles/roles.ts";
import { afterRejection, limitReason, validateMove, type CoordinatorFacts, type CoordinatorLimits } from "../src/orchestrator/coordinator.ts";

/** 設計メモ v0.21(フェーズ10-1): コーディネーターの一手を、守りの条件で検証する。許されない一手は必ず却下する */

const roles = loadRoles();
const limits: CoordinatorLimits = { maxRunsPerTask: 60, maxCostPerTaskUsd: 20 };

/** 企画の段のルーブリックは、既定ではすべて合格にしておく(関門の検査を個別に見るため) */
const ALL_STAGES = ["research", "strategy", "scope", "ux", "handoff"];
const planning = (o: Partial<CoordinatorFacts> = {}): CoordinatorFacts => ({ kind: "planning", approvals: [], testsPassed: false, integrated: false, runCount: 0, costUsd: 0, rubricPassed: ALL_STAGES, ...o });
const dev = (o: Partial<CoordinatorFacts> = {}): CoordinatorFacts => ({ ...planning(), kind: "normal", ...o });

const move = (verdict: string, o: Record<string, unknown> = {}) => ({
  verdict,
  summary: "s",
  role: null,
  input: null,
  question: null,
  gate: null,
  reason: "既定の進め方どおり",
  deviatesFromDefault: false,
  ...o,
});
const runRole = (role: string, o: Record<string, unknown> = {}) => move("run_role", { role, input: "research.md を書いてください", ...o });

const check = (output: unknown, facts: CoordinatorFacts) => validateMove(output, facts, roles, limits);
const rejected = (output: unknown, facts: CoordinatorFacts) => {
  const r = check(output, facts);
  expect(r.ok).toBe(false);
  return r.ok ? "" : `${r.kind}: ${r.reason}`;
};

describe("一手の形", () => {
  it("構造化出力が不正なら却下する", () => {
    expect(rejected({ verdict: "jump", summary: "s" }, planning())).toMatch(/^rejected: /);
    expect(rejected({ summary: "s" }, planning())).toMatch(/^rejected: /);
  });

  it("理由が空なら却下する", () => {
    expect(rejected(runRole("researcher", { reason: " " }), planning())).toMatch(/理由/);
  });

  it("一手に必要な項目が欠けていれば却下する", () => {
    expect(rejected(move("run_role", { role: "researcher" }), planning())).toMatch(/input/);
    expect(rejected(move("run_role", { input: "x" }), planning())).toMatch(/role/);
    expect(rejected(move("ask_human"), planning())).toMatch(/question/);
    expect(rejected(move("request_approval"), planning())).toMatch(/gate/);
  });

  it("許される一手は、種類ごとの形にして返す", () => {
    const r = check(runRole("researcher", { deviatesFromDefault: true, reason: "資料が十分なので短く調べる" }), planning());
    expect(r).toEqual({ ok: true, move: { type: "run_role", role: "researcher", input: "research.md を書いてください", summary: "s", reason: "資料が十分なので短く調べる", deviatesFromDefault: true } });
    expect(check(move("ask_human", { question: "対象は法人か個人か" }), planning())).toMatchObject({ ok: true, move: { type: "ask_human", question: "対象は法人か個人か" } });
    expect(check(move("fail", { reason: "題材が企画にならない" }), planning())).toMatchObject({ ok: true, move: { type: "fail" } });
  });

  it("モデルや道具の指定を返しても、一手には含めない(役割の中身は変えられない)", () => {
    const r = check(runRole("researcher", { model: "opus", tools: ["Bash"], permissions: { write: "worktree" } }), planning());
    expect(r.ok).toBe(true);
    expect(r.ok && Object.keys(r.move)).not.toEqual(expect.arrayContaining(["model", "tools", "permissions"]));
  });
});

describe("run_role: 役割", () => {
  it("存在しない役割は却下する(役割を新しく作れない)", () => {
    expect(rejected(runRole("security_expert"), planning())).toMatch(/security_expert/);
  });

  it("タスクの種類で使えない役割は却下する", () => {
    expect(rejected(runRole("implementer"), planning({ approvals: ["strategy", "scope", "handoff"] }))).toMatch(/implementer/);
    expect(rejected(runRole("strategist"), dev({ approvals: ["plan"] }))).toMatch(/strategist/);
  });

  it("コーディネーター自身と、ツールの内部や別の契機で動く役割は呼べない", () => {
    for (const r of ["coordinator", "profiler", "retrospective", "auditor", "verifier"]) {
      expect(rejected(runRole(r), dev({ approvals: ["plan", "final"], testsPassed: true }))).toMatch(new RegExp(r));
    }
  });

  it("企画: 承認された戦略の前に要件を、承認された要件の前に構造・骨格と引き渡しを書かせない", () => {
    expect(rejected(runRole("product"), planning())).toMatch(/strategy/);
    expect(rejected(runRole("ux"), planning({ approvals: ["strategy"] }))).toMatch(/scope/);
    expect(rejected(runRole("handoff"), planning({ approvals: ["strategy"] }))).toMatch(/scope/);
    expect(check(runRole("product"), planning({ approvals: ["strategy"] })).ok).toBe(true);
    expect(check(runRole("handoff"), planning({ approvals: ["strategy", "scope"] })).ok).toBe(true);
    expect(check(runRole("critic"), planning()).ok).toBe(true);
  });

  it("開発: 計画の承認の前に、設計・実装・検証の役割を動かさない", () => {
    for (const r of ["architect", "designer", "implementer", "reviewer", "qa", "design_reviewer"]) {
      expect(rejected(runRole(r), dev())).toMatch(/plan/);
      expect(check(runRole(r), dev({ approvals: ["plan"] })).ok).toBe(true);
    }
    expect(check(runRole("planner"), dev()).ok).toBe(true);
  });

  it("開発: 統合は、最終確認の承認とテストの再実行の合格の後だけ", () => {
    expect(rejected(runRole("integrator"), dev({ approvals: ["plan"], testsPassed: true }))).toMatch(/final/);
    expect(rejected(runRole("integrator"), dev({ approvals: ["plan", "final"], testsPassed: false }))).toMatch(/テスト/);
    expect(check(runRole("integrator"), dev({ approvals: ["plan", "final"], testsPassed: true })).ok).toBe(true);
  });

  it("テスト基盤整備のタスクも開発と同じ役割と関門", () => {
    expect(rejected(runRole("implementer"), dev({ kind: "test_infra" }))).toMatch(/plan/);
    expect(check(runRole("implementer"), dev({ kind: "test_infra", approvals: ["plan"] })).ok).toBe(true);
  });
});

describe("上限", () => {
  it("1タスクあたりの起動回数か費用が上限に達したら、役割を起動させない(人に回す)", () => {
    expect(rejected(runRole("researcher"), planning({ runCount: 60 }))).toMatch(/^limit: .*60/);
    expect(rejected(runRole("researcher"), planning({ costUsd: 20 }))).toMatch(/^limit: .*20/);
    expect(check(runRole("researcher"), planning({ runCount: 59, costUsd: 19.9 })).ok).toBe(true);
  });

  it("上限に達していても、人に聞く・失敗にする一手は通す", () => {
    expect(check(move("ask_human", { question: "続けますか" }), planning({ runCount: 60 })).ok).toBe(true);
    expect(check(move("fail", { reason: "上限" }), planning({ costUsd: 50 })).ok).toBe(true);
  });

  it("limitReason は上限に達していなければ null", () => {
    expect(limitReason(planning(), limits)).toBeNull();
    expect(limitReason(planning({ runCount: 61 }), limits)).toMatch(/起動/);
    expect(limitReason(planning({ costUsd: 21 }), limits)).toMatch(/費用/);
  });
});

describe("request_approval: 人の承認の関門", () => {
  it("タスクの種類に無い関門は却下する", () => {
    expect(rejected(move("request_approval", { gate: "plan" }), planning())).toMatch(/plan/);
    expect(rejected(move("request_approval", { gate: "strategy" }), dev())).toMatch(/strategy/);
  });

  it("前の関門を飛ばした承認は却下する", () => {
    expect(rejected(move("request_approval", { gate: "scope" }), planning())).toMatch(/strategy/);
    expect(rejected(move("request_approval", { gate: "handoff" }), planning({ approvals: ["strategy"] }))).toMatch(/scope/);
    expect(rejected(move("request_approval", { gate: "design" }), dev())).toMatch(/plan/);
    expect(rejected(move("request_approval", { gate: "final" }), dev({ testsPassed: true }))).toMatch(/plan/);
    expect(check(move("request_approval", { gate: "strategy" }), planning()).ok).toBe(true);
    expect(check(move("request_approval", { gate: "plan" }), dev()).ok).toBe(true);
  });

  it("最終確認は、テストの再実行が合格してから", () => {
    expect(rejected(move("request_approval", { gate: "final" }), dev({ approvals: ["plan"] }))).toMatch(/テスト/);
    expect(check(move("request_approval", { gate: "final" }), dev({ approvals: ["plan"], testsPassed: true })).ok).toBe(true);
  });

  it("すでに承認済み(失効していない)の関門は求め直さない", () => {
    expect(rejected(move("request_approval", { gate: "strategy" }), planning({ approvals: ["strategy"] }))).toMatch(/承認済み/);
  });
});

describe("complete", () => {
  it("企画: 戦略・要件・引き渡しの承認がそろうまで完了にできない", () => {
    expect(rejected(move("complete"), planning({ approvals: ["strategy", "scope"] }))).toMatch(/handoff/);
    expect(check(move("complete"), planning({ approvals: ["strategy", "scope", "handoff"] })).ok).toBe(true);
  });

  it("開発: 計画と最終確認の承認、テストの再実行の合格、統合がそろうまで完了にできない", () => {
    expect(rejected(move("complete"), dev({ approvals: ["plan"], testsPassed: true, integrated: true }))).toMatch(/final/);
    expect(rejected(move("complete"), dev({ approvals: ["final"], testsPassed: true, integrated: true }))).toMatch(/plan/);
    expect(rejected(move("complete"), dev({ approvals: ["plan", "final"], testsPassed: false, integrated: true }))).toMatch(/テスト/);
    expect(rejected(move("complete"), dev({ approvals: ["plan", "final"], testsPassed: true, integrated: false }))).toMatch(/統合/);
    expect(check(move("complete"), dev({ approvals: ["plan", "final"], testsPassed: true, integrated: true })).ok).toBe(true);
  });
});

describe("ルーブリック(10-1b。設計メモ v0.22)", () => {
  it("企画: 段を進める一手は、その段のルーブリックの must がすべて合格してから", () => {
    // 調査 → 戦略を書く
    expect(rejected(runRole("strategist"), planning({ rubricPassed: [] }))).toMatch(/research/);
    expect(check(runRole("strategist"), planning({ rubricPassed: ["research"] })).ok).toBe(true);
    // 戦略・要件・引き渡しの承認を求める
    expect(rejected(move("request_approval", { gate: "strategy" }), planning({ rubricPassed: ["research"] }))).toMatch(/strategy/);
    expect(rejected(move("request_approval", { gate: "scope" }), planning({ approvals: ["strategy"], rubricPassed: ["research", "strategy"] }))).toMatch(/scope/);
    // 構造・骨格 → 引き渡しを書く
    expect(rejected(runRole("handoff"), planning({ approvals: ["strategy", "scope"], rubricPassed: ["research", "strategy", "scope"] }))).toMatch(/ux/);
    // 完了
    expect(rejected(move("complete"), planning({ approvals: ["strategy", "scope", "handoff"], rubricPassed: ["research", "strategy", "scope", "ux"] }))).toMatch(/handoff/);
  });

  it("書き直しと批評は、ルーブリックが不合格のままでも呼べる(直すための一手)", () => {
    expect(check(runRole("researcher"), planning({ rubricPassed: [] })).ok).toBe(true);
    expect(check(runRole("critic"), planning({ rubricPassed: [] })).ok).toBe(true);
    expect(check(runRole("product"), planning({ approvals: ["strategy"], rubricPassed: ["research", "strategy"] })).ok).toBe(true);
  });

  it("開発のタスクでは、まだルーブリックを見ない(10-4 で reviewer・qa に足す)", () => {
    expect(check(move("request_approval", { gate: "plan" }), dev({ rubricPassed: [] })).ok).toBe(true);
  });
});

describe("却下が続いたとき", () => {
  it("1回目の却下は理由を添えてコーディネーターに返し、2回続いたら人に回す", () => {
    expect(afterRejection(1)).toBe("ask_coordinator");
    expect(afterRejection(2)).toBe("needs_input");
    expect(afterRejection(3)).toBe("needs_input");
  });
});

describe("コーディネーターの役割の定義", () => {
  it("一手の種類を判定として返し、何も書き込まない", () => {
    const c = roles.get("coordinator")!;
    expect(c.verdicts).toEqual(["run_role", "ask_human", "request_approval", "complete", "fail"]);
    expect(c.permissions.write).toBe("none");
    expect(c.tools).not.toContain("Bash");
    expect(c.tools).not.toContain("Write");
    expect(c.model).toBe("sonnet");
  });
});
