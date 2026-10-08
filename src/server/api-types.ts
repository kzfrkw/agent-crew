/**
 * 読み取り API の型(docs/structure.md)。サーバーと GUI(gui/)で共有する。
 * 型だけを置き、実行時のコードを import しない(GUI のビルドに Node のコードを持ち込まないため)。
 */

import type { TaskState } from "../orchestrator/states.ts";

export type { TaskState };

/** 人の対応が必要な理由の種類 */
export type Attention = "approve_plan" | "approve_final" | "answer" | "failed" | "human_working";

/** 状態ごとに人が次にすること。フェーズ2は CLI コマンドを示し、フェーズ3でボタンにする */
export type NextAction = {
  kind: "approve" | "reject" | "answer" | "takeover" | "return" | "cancel" | "push";
  label: string;
  command: string;
};

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
