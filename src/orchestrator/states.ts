/** タスクの状態(設計メモ第5章)。フェーズ1は designing を使わない */
export const TASK_STATES = [
  "queued",
  "planning",
  "awaiting_plan_approval",
  "implementing",
  "reviewing",
  "qa",
  "awaiting_final_approval",
  "integrating",
  "done",
  "needs_input",
  "human_working",
  "failed",
  "cancelled",
] as const;

export type TaskState = (typeof TASK_STATES)[number];
