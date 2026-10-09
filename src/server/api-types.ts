/**
 * 読み取り API の型(docs/structure.md)。サーバーと GUI(gui/)で共有する。
 * 型だけを置き、実行時のコードを import しない(GUI のビルドに Node のコードを持ち込まないため)。
 */

import type { TaskState } from "../orchestrator/states.ts";

export type { TaskState };

/** 人の対応が必要な理由の種類 */
export type Attention = "approve_plan" | "approve_design" | "approve_final" | "answer" | "failed" | "human_working";

/** 人の操作(POST /api/tasks/:id/actions の本文)。CLI と同じ関数を通す */
export type ActionRequest =
  /** design は計画の承認だけ。設計の段で動かす役割の、人による上書き */
  | { action: "approve"; kind: "plan" | "design" | "final"; comment?: string; design?: DesignOptions }
  | { action: "reject"; kind: "plan" | "design" | "final"; comment: string }
  | { action: "answer"; message: string }
  | { action: "stop" }
  | { action: "takeover" }
  | { action: "return" }
  | { action: "cancel" }
  | { action: "update_base" }
  | { action: "open_editor" };

export type DesignOptions = { architect: boolean; designer: boolean };

/**
 * 状態ごとに人が次にすること。GUI はこれをボタンにし、request を送る(状態とボタンの対応を GUI に持たせない)。
 * input があれば、送る前にその欄(comment / message)を入力させる。
 */
export type NextAction = {
  kind: ActionRequest["action"] | "push";
  label: string;
  /** CLI での同じ操作(CLI に無い操作は null) */
  command: string | null;
  /** GUI のボタンが送る要求(push のように人が手元で行うものは null) */
  request: ActionRequest | null;
  input?: { field: "comment" | "message"; required: boolean; placeholder: string };
  /** 主な操作(塗りつぶしのボタン)か */
  primary?: boolean;
  /** 押す前に確認する文(停止・取り消しなど) */
  confirm?: string;
  /** 送る前に選べるオン/オフ(計画の承認での設計者・デザイナー)。選んだ値は request.design に入れて送る */
  options?: { key: keyof DesignOptions; label: string; value: boolean }[];
  /** options の判断材料(プランナーの理由など) */
  optionsNote?: string;
};

export type WorkerView = { state: "running" | "paused" | "locked" | "disabled"; active: number[] };

export type CreateTaskRequest = { projectId: number; title: string; body: string; sourceUrl?: string };

export type ActionResult = { message: string; task: TaskSummary };

export type ProjectSummary = {
  id: number;
  name: string;
  profileStatus: string;
  testInfra: string;
  allowWithoutTests: boolean;
};

export type RunSummary = {
  id: number;
  taskId: number | null;
  projectId: number | null;
  role: string;
  model: string | null;
  state: "running" | "succeeded" | "failed" | "timeout" | "cancelled";
  verdict: string | null;
  summary: string | null;
  error: string | null;
  costUsd: number | null;
  startedAt: string;
  endedAt: string | null;
  /** 終了していれば所要秒数 */
  durationSec: number | null;
};

export type TaskSummary = {
  id: number;
  projectId: number;
  title: string;
  kind: "normal" | "test_infra";
  state: TaskState;
  stateLabel: string;
  heldFromState: TaskState | null;
  assignee: "agent" | "human" | null;
  reviewRounds: number;
  /** 設計の段で動かす役割(フェーズ4) */
  design: DesignOptions;
  createdAt: string;
  updatedAt: string;
  attention: Attention | null;
  /** 回答待ちの質問や失敗の理由 */
  reason: string | null;
  running: Pick<RunSummary, "id" | "role" | "model" | "startedAt"> | null;
  /** 人の対応が必要なときの主な操作(nextActions の先頭) */
  primaryAction: NextAction | null;
};

export type Overview = {
  worker: WorkerView;
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  running: (RunSummary & { taskTitle: string | null })[];
  stateLabels: Record<TaskState, string>;
};

export type ArtifactSummary = {
  id: number;
  taskId: number | null;
  runId: number | null;
  kind: string;
  fileName: string;
  verdict: string | null;
  createdAt: string;
  /** /files/ で開ける URL(ファイルが無ければ null) */
  url: string | null;
};

export type ApprovalView = {
  id: number;
  kind: string;
  result: "approved" | "rejected";
  commitSha: string | null;
  comment: string | null;
  createdAt: string;
  invalidatedAt: string | null;
};

export type WorktreeView = { repoRole: string; worktreePath: string; branchName: string; baseSha: string };

export type TaskDetail = {
  task: TaskSummary & { body: string; sourceKind: string; sourceUrl: string | null };
  project: ProjectSummary;
  worktrees: WorktreeView[];
  approvals: ApprovalView[];
  artifacts: ArtifactSummary[];
  runs: RunSummary[];
  totals: { costUsd: number; durationSec: number };
  nextActions: NextAction[];
  runActive: boolean;
  /** このサーバーで操作できるか(serve --no-worker の読み取り専用なら false。GUI はボタンの代わりに CLI のコマンドを出す) */
  operable: boolean;
};

export type ArtifactDetail = {
  artifact: ArtifactSummary;
  task: { id: number; title: string; projectId: number } | null;
  run: RunSummary | null;
  /** 同じタスクの成果物(切り替え用) */
  siblings: ArtifactSummary[];
  mediaType: "markdown" | "text" | "image" | "other";
  /** テキストなら本文(Markdown は frontmatter を除いたもの) */
  content: string | null;
  frontmatter: Record<string, unknown> | null;
};

export type RunDetail = {
  run: RunSummary;
  task: { id: number; title: string } | null;
  project: ProjectSummary | null;
  artifacts: ArtifactSummary[];
  /** 生ログ(stream.jsonl)の URL */
  streamUrl: string | null;
};

export type ProjectDetail = {
  project: ProjectSummary;
  repos: { id: number; path: string; role: string; defaultBranch: string }[];
  profile: unknown;
  profileMd: string | null;
  decisionsMd: string | null;
  runs: RunSummary[];
  tasks: TaskSummary[];
};

export type EventView = {
  id: number;
  taskId: number | null;
  runId: number | null;
  kind: string;
  payload: unknown;
  createdAt: string;
};

export type EventsPage = { events: EventView[]; lastId: number };

/** SSE の change イベント。変化した対象を知らせ、GUI は該当する API を取り直す */
export type ChangeNotice = { tasks: boolean; runs: boolean; lastEventId: number };
