import type { TaskState } from "../../../src/server/api-types.ts";

/** タスクのパイプライン上の位置(docs/surface.md の「パイプライン表示」) */

export type StageStatus = "done" | "current" | "todo" | "blocked" | "human" | "failed";
export type Stage = { state: TaskState; label: string; status: StageStatus };

const STAGES: { state: TaskState; label: string }[] = [
  { state: "planning", label: "計画" },
  { state: "awaiting_plan_approval", label: "計画の承認" },
  { state: "implementing", label: "実装" },
  { state: "reviewing", label: "レビュー" },
  { state: "qa", label: "QA" },
  { state: "awaiting_final_approval", label: "最終確認" },
  { state: "integrating", label: "統合" },
  { state: "done", label: "完了" },
];

const HOLD: Partial<Record<TaskState, StageStatus>> = { needs_input: "blocked", human_working: "human", failed: "failed" };
/** 人の承認を待つ段(現在地だが、エージェントは動いていない) */
const WAITING: TaskState[] = ["awaiting_plan_approval", "awaiting_final_approval"];

export function pipelineOf(state: TaskState, heldFrom: TaskState | null): Stage[] {
  if (state === "done") return STAGES.map((s) => ({ ...s, status: "done" }));
  const hold = HOLD[state];
  const at = STAGES.findIndex((s) => s.state === (hold ? heldFrom : state));
  return STAGES.map((s, i) => ({
    ...s,
    status: at < 0 || i > at ? "todo" : i < at ? "done" : (hold ?? (WAITING.includes(state) ? "blocked" : "current")),
  }));
}
