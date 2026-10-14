import type { ApprovalKind } from "../db/store.ts";
import type { TaskState } from "./states.ts";

/**
 * タスクの状態遷移(設計メモ第5章)。DBやプロセスに触れない純粋関数。
 * 状態遷移は役割の「判定の列挙値」と人の操作だけを見て決める。
 */

/** researcher〜handoff は企画の流れの書く役(フェーズ9。批評担当 critic は各段のハンドラーの中で動く) */
export type Role = "planner" | "architect" | "designer" | "implementer" | "reviewer" | "qa" | "design_reviewer" | "integrator" | "researcher" | "strategist" | "product" | "ux" | "handoff";

/** 人の承認の種類。strategy / scope / handoff は企画の流れ */
export type HumanApprovalKind = "plan" | "design" | "final" | "strategy" | "scope" | "handoff";

/** 設計の段で動かす役割(プランナーが判定し、計画の承認時に人が上書きできる) */
export type DesignPlan = { architect: boolean; designer: boolean };

/** 状態で起動する役割。designing は設計者とデザイナーを1つのハンドラーで順に動かすため、代表として architect */
const ROLE_BY_STATE: Partial<Record<TaskState, Role>> = {
  planning: "planner",
  designing: "architect",
  implementing: "implementer",
  reviewing: "reviewer",
  qa: "qa",
  design_reviewing: "design_reviewer",
  integrating: "integrator",
  p_researching: "researcher",
  p_strategizing: "strategist",
  p_scoping: "product",
  p_ux: "ux",
  p_handing_off: "handoff",
};

/** その状態で起動する役割。人の承認待ちなど、エージェントが動かない状態では null */
export function roleForState(state: TaskState): Role | null {
  return ROLE_BY_STATE[state] ?? null;
}

type Outcome = { to: TaskState } | "bounce" | "hold";

/** 役割ごとに返せる判定と、その結果 */
const VERDICTS: Record<Role, Record<string, Outcome>> = {
  planner: { ready: { to: "awaiting_plan_approval" }, need_human: "hold" },
  // 設計者の ready は、デザイナーを動かさないときだけ返ってくる(動かすならハンドラーが続けてデザイナーを起動する)
  architect: { ready: { to: "implementing" }, need_human: "hold" },
  designer: { ready: { to: "awaiting_design_approval" }, need_human: "hold" },
  implementer: { done: { to: "reviewing" }, blocked: "hold", need_human: "hold" },
  reviewer: { approve: { to: "qa" }, changes_requested: "bounce", need_human: "hold" },
  // QA の合格は、デザイナーを動かしたタスクならデザインレビューへ(遷移の中で決める)
  qa: { passed: { to: "awaiting_final_approval" }, failed: "bounce", need_human: "hold" },
  design_reviewer: { approve: { to: "awaiting_final_approval" }, changes_requested: "bounce", need_human: "hold" },
  integrator: { done: { to: "done" }, blocked: "hold" },
  // 企画の段: 批評担当が approve したら、書く役の ready として次へ進む
  researcher: { ready: { to: "p_strategizing" }, need_human: "hold" },
  strategist: { ready: { to: "awaiting_strategy_approval" }, need_human: "hold" },
  product: { ready: { to: "awaiting_scope_approval" }, need_human: "hold" },
  ux: { ready: { to: "p_handing_off" }, need_human: "hold" },
  handoff: { ready: { to: "awaiting_handoff_approval" }, need_human: "hold" },
};

const PLANNING_ROLES: Role[] = ["researcher", "strategist", "product", "ux", "handoff"];
const PLANNING_STAGES: TaskState[] = ["p_researching", "p_strategizing", "p_scoping", "p_ux", "p_handing_off"];

/** 人が変更して戻したとき、レビューからやり直す対象になる段階(実装が存在する段階) */
const AFTER_IMPLEMENTATION: TaskState[] = ["implementing", "reviewing", "qa", "design_reviewing", "awaiting_final_approval", "integrating"];
/** ベースを取り込んだとき、レビューからやり直す段階(レビュー済みの内容が変わるため) */
const REVIEWED: TaskState[] = ["reviewing", "qa", "design_reviewing", "awaiting_final_approval", "integrating"];
const RESTART_REVIEW: Effect[] = [{ type: "invalidate_approvals", kinds: ["review", "qa", "final"] }];

export type TaskEvent =
  | { type: "start" }
  | { type: "verdict"; role: Role; verdict: string }
  | { type: "tests_failed" }
  /** 計画の承認では、設計の段で動かす役割を人が上書きできる */
  | { type: "approve"; kind: HumanApprovalKind; design?: DesignPlan }
  | { type: "reject"; kind: HumanApprovalKind }
  /** 企画の段の批評が差し戻した(フェーズ9)。同じ段の書く役をやり直す */
  | { type: "critique_bounce" }
  | { type: "answer" }
  | { type: "takeover" }
  | { type: "return"; humanChanged: boolean }
  | { type: "limit_exceeded"; reason: string }
  /** 役割の実行エラー(成果物が無い、判定が不正、コミットが無いなど)。人の判断を待つ */
  | { type: "run_error"; reason: string }
  | { type: "fail"; reason: string }
  | { type: "retry" }
  /** ベース(既定ブランチ)を取り込んだ。実装以降の段階なら、承認が成り立たないのでレビューからやり直す */
  | { type: "base_updated" }
  /** ベースの取り込みで衝突した。人が解決する */
  | { type: "base_conflict"; reason: string }
  | { type: "cancel" }
  /** 計画の承認で、人が分割して進めることを選んだ(8-2) */
  | { type: "split" }
  /** 分割した子タスクがすべて完了した */
  | { type: "children_done" }
  /** 分割した子タスクが取り消された。人が判断する */
  | { type: "child_cancelled"; reason: string }
  /** 同じ理由の差し戻しが続いた(8-3)。上限を待たずに人に回す */
  | { type: "repeated_failure"; reason: string }
  /** 人が実行中の役割を止めた。その段で人の判断を待つ */
  | { type: "stopped" };

export type TaskSnapshot = { state: TaskState; heldFromState: TaskState | null; reviewRounds: number; design?: DesignPlan; kind?: "normal" | "test_infra" | "planning" };

const NO_DESIGN: DesignPlan = { architect: false, designer: false };

export type TransitionContext = {
  maxReviewRounds: number;
  /** このタスクのエージェントが実行中か */
  runActive: boolean;
  /** テスト基盤が整っている、または人が例外を承認している */
  testGateOpen: boolean;
};

export type Effect = { type: "invalidate_approvals"; kinds: ApprovalKind[] };

export type TransitionResult = Omit<TaskSnapshot, "design"> & { design: DesignPlan; assignee: "agent" | "human" | null; effects: Effect[] };

export class TransitionError extends Error {
  override name = "TransitionError";
}

export function transition(t: TaskSnapshot, e: TaskEvent, c: TransitionContext): TransitionResult {
  const fail = (why: string): never => {
    throw new TransitionError(`状態 ${t.state} では ${e.type} を受け付けません: ${why}`);
  };
  const to = (state: TaskState, over: Partial<TransitionResult> = {}): TransitionResult => ({
    state,
    heldFromState: null,
    reviewRounds: t.reviewRounds,
    design: t.design ?? NO_DESIGN,
    assignee: state === "human_working" ? "human" : roleForState(state) ? "agent" : null,
    effects: [],
    ...over,
  });
  const hold = (from: TaskState) => to("needs_input", { heldFromState: from });
  const bounce = () => {
    const rounds = t.reviewRounds + 1;
    return rounds > c.maxReviewRounds
      ? to("needs_input", { heldFromState: "implementing", reviewRounds: rounds })
      : to("implementing", { reviewRounds: rounds });
  };

  if (t.state === "done" || t.state === "cancelled") fail("終了したタスクです");

  // どの状態からでも受け付ける出来事
  if (e.type === "cancel") return to("cancelled");
  if (e.type === "fail") {
    if (t.state === "failed") fail("すでに失敗しています");
    return to("failed", { heldFromState: t.state });
  }

  if (t.state === "human_working") {
    if (e.type !== "return") fail("人が作業中です。先に「エージェントに戻す」を行ってください");
  }

  switch (e.type) {
    case "start":
      if (t.state !== "queued") fail("開始できるのは queued だけです");
      if (t.kind === "planning") return to("p_researching");
      if (!c.testGateOpen) fail("テスト基盤の整備が完了していません(人が例外を承認すれば開始できます)");
      return to("planning");

    case "verdict": {
      const role = roleForState(t.state);
      const allowed = t.state === "designing" ? ["architect", "designer"] : [role];
      if (!allowed.includes(e.role)) fail(`この状態の役割は ${role ?? "なし"} です(受け取った判定は ${e.role})`);
      const outcome = VERDICTS[e.role][e.verdict];
      if (!outcome) fail(`${e.role} は ${e.verdict} を返せません`);
      if (outcome === "bounce") return bounce();
      if (outcome === "hold") return hold(t.state);
      // 企画の段は、次の段で差し戻しの回数を数え直す
      if (PLANNING_ROLES.includes(e.role)) return to(outcome!.to, { reviewRounds: 0 });
      if (e.role === "qa" && e.verdict === "passed" && t.design?.designer) return to("design_reviewing");
      return to(outcome!.to);
    }

    case "critique_bounce": {
      if (!PLANNING_STAGES.includes(t.state)) fail("企画の段ではありません");
      const rounds = t.reviewRounds + 1;
      return rounds > c.maxReviewRounds ? to("needs_input", { heldFromState: t.state, reviewRounds: rounds }) : to(t.state, { reviewRounds: rounds });
    }

    case "split":
      if (t.state !== "awaiting_plan_approval") fail("分割できるのは計画の承認待ちだけです");
      return to("split");

    case "children_done":
      if (t.state !== "split") fail("分割済みではありません");
      return to("done");

    case "child_cancelled":
      if (t.state !== "split") fail("分割済みではありません");
      return to("needs_input", { heldFromState: "split" });

    case "repeated_failure":
      if (PLANNING_STAGES.includes(t.state)) return to("needs_input", { heldFromState: t.state, reviewRounds: t.reviewRounds + 1 });
      if (!["reviewing", "qa", "design_reviewing"].includes(t.state)) fail("差し戻しの段ではありません");
      return to("needs_input", { heldFromState: "implementing", reviewRounds: t.reviewRounds + 1 });

    case "tests_failed":
      if (t.state !== "reviewing") fail("テストの再確認は実装の直後(reviewing)に行います");
      return bounce();

    case "approve":
    case "reject": {
      const waiting = {
        plan: "awaiting_plan_approval",
        design: "awaiting_design_approval",
        final: "awaiting_final_approval",
        strategy: "awaiting_strategy_approval",
        scope: "awaiting_scope_approval",
        handoff: "awaiting_handoff_approval",
      }[e.kind];
      if (t.state !== waiting) fail(`${e.kind} の承認待ちではありません`);
      if (e.type === "reject") {
        const back = { plan: "planning", design: "designing", final: "implementing", strategy: "p_strategizing", scope: "p_scoping", handoff: "p_handing_off" }[e.kind] as TaskState;
        // 企画の段の却下は、その段の差し戻しの回数を数え直す(開発の却下は従来どおり数えない)
        return to(back, ["strategy", "scope", "handoff"].includes(e.kind) ? { reviewRounds: 0 } : {});
      }
      // 企画: 戦略 → 要件 → 構造・骨格。引き渡しの承認で開発のタスクを作り、子の完了を待つ(親子の仕組みはフェーズ8の分割と同じ)
      if (e.kind === "strategy") return to("p_scoping", { reviewRounds: 0 });
      if (e.kind === "scope") return to("p_ux", { reviewRounds: 0 });
      if (e.kind === "handoff") return to("split");
      if (e.kind === "plan") {
        const design = e.design ?? t.design ?? NO_DESIGN;
        return to(design.architect || design.designer ? "designing" : "implementing", { design });
      }
      return to(e.kind === "design" ? "implementing" : "integrating");
    }

    case "answer":
      if (t.state !== "needs_input" || !t.heldFromState) fail("回答待ちではありません");
      return to(t.heldFromState!, { reviewRounds: 0 });

    case "takeover":
      if (c.runActive) fail("エージェントが実行中です。先に停止してください");
      return to("human_working", { heldFromState: t.state === "needs_input" ? t.heldFromState : t.state });

    case "return": {
      if (t.state !== "human_working" || !t.heldFromState) fail("人が作業中ではありません");
      const from = t.heldFromState!;
      if (e.humanChanged && AFTER_IMPLEMENTATION.includes(from)) {
        return to("reviewing", { reviewRounds: 0, effects: RESTART_REVIEW });
      }
      return to(from);
    }

    case "stopped":
      if (!roleForState(t.state)) fail("エージェントが動く状態ではありません");
      return hold(t.state);

    case "limit_exceeded":
    case "run_error":
      if (!roleForState(t.state)) fail("エージェントが動く状態ではありません");
      return hold(t.state);

    case "base_updated": {
      const stage = t.state === "needs_input" ? t.heldFromState : t.state;
      if (stage && REVIEWED.includes(stage)) return to("reviewing", { effects: RESTART_REVIEW });
      return to(t.state, { heldFromState: t.heldFromState });
    }

    case "base_conflict":
      return hold(t.state === "needs_input" ? t.heldFromState ?? t.state : t.state);

    case "retry":
      if (t.state !== "failed" || !t.heldFromState) fail("失敗したタスクではありません");
      return to(t.heldFromState!);
  }
}
