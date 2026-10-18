/** タスクの状態(設計メモ第5章)。designing / awaiting_design_approval / design_reviewing はフェーズ4から */
export const TASK_STATES = [
  "queued",
  "planning",
  "awaiting_plan_approval",
  "designing",
  "awaiting_design_approval",
  "implementing",
  "reviewing",
  "qa",
  "design_reviewing",
  "awaiting_final_approval",
  "integrating",
  // 企画の流れ(フェーズ9)。各段は書く役 → 批評の順に動く
  "p_researching",
  "p_strategizing",
  "awaiting_strategy_approval",
  "p_scoping",
  "awaiting_scope_approval",
  "p_ux",
  "p_handing_off",
  "awaiting_handoff_approval",
  /** コーディネーターが進め方を決めて役割を動かしている(フェーズ10。どの役割が動いているかは実行の記録から見る) */
  "coordinating",
  "done",
  /** 分割した親。子タスクがすべて完了するのを待つ(フェーズ8) */
  "split",
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
  designing: "設計中",
  awaiting_design_approval: "デザイン仕様の承認待ち",
  implementing: "実装中",
  reviewing: "レビュー中",
  qa: "QA中",
  design_reviewing: "デザインレビュー中",
  awaiting_final_approval: "最終確認待ち",
  integrating: "統合中",
  p_researching: "調査中",
  p_strategizing: "戦略の検討中",
  awaiting_strategy_approval: "戦略の承認待ち",
  p_scoping: "要件の整理中",
  awaiting_scope_approval: "要件の承認待ち",
  p_ux: "構造・骨格の設計中",
  p_handing_off: "引き渡しの準備中",
  awaiting_handoff_approval: "引き渡しの承認待ち",
  coordinating: "進行中(コーディネーター)",
  done: "完了",
  split: "分割済み(子タスクの完了待ち)",
  needs_input: "人の回答待ち",
  human_working: "人が作業中",
  failed: "失敗",
  cancelled: "取り消し",
};

/** 人の対応が必要な状態(一覧で目立たせる) */
export const NEEDS_HUMAN: TaskState[] = [
  "needs_input",
  "awaiting_plan_approval",
  "awaiting_design_approval",
  "awaiting_final_approval",
  "awaiting_strategy_approval",
  "awaiting_scope_approval",
  "awaiting_handoff_approval",
  "failed",
];
