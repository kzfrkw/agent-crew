import type { DesignOptions, TaskState } from "../../../src/server/api-types.ts";

/** タスクのパイプライン上の位置(docs/surface.md の「パイプライン表示」) */

export type StageStatus = "done" | "current" | "todo" | "blocked" | "human" | "failed" | "skipped";
export type Stage = { state: TaskState; label: string; status: StageStatus };

const STAGES: { state: TaskState; label: string }[] = [
  { state: "planning", label: "計画" },
  { state: "awaiting_plan_approval", label: "計画の承認" },
  { state: "designing", label: "設計" },
  { state: "awaiting_design_approval", label: "デザインの承認" },
  { state: "implementing", label: "実装" },
  { state: "reviewing", label: "レビュー" },
  { state: "qa", label: "QA" },
  { state: "awaiting_final_approval", label: "最終確認" },
  { state: "integrating", label: "統合" },
  { state: "done", label: "完了" },
];

const HOLD: Partial<Record<TaskState, StageStatus>> = { needs_input: "blocked", human_working: "human", failed: "failed" };
/** 人の承認を待つ段(現在地だが、エージェントは動いていない) */
const WAITING: TaskState[] = ["awaiting_plan_approval", "awaiting_design_approval", "awaiting_final_approval"];

/** 設計の段は、動かす役割がなければ飛ばす。デザインの承認はデザイナーを動かすときだけ */
function skipped(state: TaskState, design: DesignOptions): boolean {
  if (state === "designing") return !design.architect && !design.designer;
  if (state === "awaiting_design_approval") return !design.designer;
  return false;
}

export function pipelineOf(state: TaskState, heldFrom: TaskState | null, design: DesignOptions = { architect: false, designer: false }): Stage[] {
  const hold = HOLD[state];
  const at = state === "done" ? STAGES.length : STAGES.findIndex((s) => s.state === (hold ? heldFrom : state));
  return STAGES.map((s, i) => ({
    ...s,
    status: skipped(s.state, design)
      ? "skipped"
      : state === "done"
        ? "done"
        : at < 0 || i > at
          ? "todo"
          : i < at
            ? "done"
            : (hold ?? (WAITING.includes(state) ? "blocked" : "current")),
  }));
}
