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

/** 表示用の名前 */
export const STATE_LABELS: Record<TaskState, string> = {
  queued: "待機",
  planning: "計画中",
  awaiting_plan_approval: "計画の承認待ち",
  implementing: "実装中",
  reviewing: "レビュー中",
  qa: "QA中",
  awaiting_final_approval: "最終確認待ち",
  integrating: "統合中",
  done: "完了",
  needs_input: "人の回答待ち",
  human_working: "人が作業中",
  failed: "失敗",
  cancelled: "取り消し",
};

/** 人の対応が必要な状態(一覧で目立たせる) */
export const NEEDS_HUMAN: TaskState[] = ["needs_input", "awaiting_plan_approval", "awaiting_final_approval", "failed"];
