import type { ApprovalKind } from "../db/store.ts";
import type { TaskState } from "./states.ts";

/**
 * タスクの状態遷移(設計メモ第5章)。DBやプロセスに触れない純粋関数。
 * 状態遷移は役割の「判定の列挙値」と人の操作だけを見て決める。
 */

export type Role = "planner" | "implementer" | "reviewer" | "qa" | "integrator";

const ROLE_BY_STATE: Partial<Record<TaskState, Role>> = {
  planning: "planner",
  implementing: "implementer",
  reviewing: "reviewer",
  qa: "qa",
  integrating: "integrator",
};

/** その状態で起動する役割。人の承認待ちなど、エージェントが動かない状態では null */
export function roleForState(state: TaskState): Role | null {
  return ROLE_BY_STATE[state] ?? null;
}

type Outcome = { to: TaskState } | "bounce" | "hold";

/** 役割ごとに返せる判定と、その結果 */
const VERDICTS: Record<Role, Record<string, Outcome>> = {
  planner: { ready: { to: "awaiting_plan_approval" }, need_human: "hold" },
  implementer: { done: { to: "reviewing" }, blocked: "hold", need_human: "hold" },
  reviewer: { approve: { to: "qa" }, changes_requested: "bounce", need_human: "hold" },
  qa: { passed: { to: "awaiting_final_approval" }, failed: "bounce", need_human: "hold" },
  integrator: { done: { to: "done" }, blocked: "hold" },
};

/** 人が変更して戻したとき、レビューからやり直す対象になる段階(実装が存在する段階) */
const AFTER_IMPLEMENTATION: TaskState[] = ["implementing", "reviewing", "qa", "awaiting_final_approval", "integrating"];

export type TaskEvent =
  | { type: "start" }
  | { type: "verdict"; role: Role; verdict: string }
  | { type: "tests_failed" }
  | { type: "approve"; kind: "plan" | "final" }
  | { type: "reject"; kind: "plan" | "final" }
  | { type: "answer" }
  | { type: "takeover" }
  | { type: "return"; humanChanged: boolean }
  | { type: "limit_exceeded"; reason: string }
  | { type: "fail"; reason: string }
  | { type: "retry" }
  | { type: "cancel" };

export type TaskSnapshot = { state: TaskState; heldFromState: TaskState | null; reviewRounds: number };

export type TransitionContext = {
  maxReviewRounds: number;
  /** このタスクのエージェントが実行中か */
  runActive: boolean;
  /** テスト基盤が整っている、または人が例外を承認している */
  testGateOpen: boolean;
};

export type Effect = { type: "invalidate_approvals"; kinds: ApprovalKind[] };

export type TransitionResult = TaskSnapshot & { assignee: "agent" | "human" | null; effects: Effect[] };

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
      if (!c.testGateOpen) fail("テスト基盤の整備が完了していません(人が例外を承認すれば開始できます)");
      return to("planning");

    case "verdict": {
      const role = roleForState(t.state);
      if (role !== e.role) fail(`この状態の役割は ${role ?? "なし"} です(受け取った判定は ${e.role})`);
      const outcome = VERDICTS[e.role][e.verdict];
      if (!outcome) fail(`${e.role} は ${e.verdict} を返せません`);
      if (outcome === "bounce") return bounce();
      if (outcome === "hold") return hold(t.state);
      return to(outcome!.to);
    }

    case "tests_failed":
      if (t.state !== "reviewing") fail("テストの再確認は実装の直後(reviewing)に行います");
      return bounce();

    case "approve":
    case "reject": {
      const waiting = e.kind === "plan" ? "awaiting_plan_approval" : "awaiting_final_approval";
      if (t.state !== waiting) fail(`${e.kind} の承認待ちではありません`);
      if (e.type === "approve") return to(e.kind === "plan" ? "implementing" : "integrating");
      return to(e.kind === "plan" ? "planning" : "implementing");
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
        return to("reviewing", {
          reviewRounds: 0,
          effects: [{ type: "invalidate_approvals", kinds: ["review", "qa", "final"] }],
        });
      }
      return to(from);
    }

    case "limit_exceeded":
      if (!roleForState(t.state)) fail("エージェントが動く状態ではありません");
      return hold(t.state);

    case "retry":
      if (t.state !== "failed" || !t.heldFromState) fail("失敗したタスクではありません");
      return to(t.heldFromState!);
  }
}
