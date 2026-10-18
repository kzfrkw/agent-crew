/**
 * 読み取り API の型(docs/structure.md)。サーバーと GUI(gui/)で共有する。
 * 型だけを置き、実行時のコードを import しない(GUI のビルドに Node のコードを持ち込まないため)。
 */

import type { TaskState } from "../orchestrator/states.ts";

export type { TaskState };

/** 人の対応が必要な理由の種類 */
export type Attention = "approve_plan" | "approve_design" | "approve_final" | "approve_planning" | "answer" | "failed" | "human_working";

/** 人の操作(POST /api/tasks/:id/actions の本文)。CLI と同じ関数を通す */
/** 人の承認の種類。strategy / scope / handoff は企画の流れ(フェーズ9) */
export type ApprovalKindView = "plan" | "design" | "final" | "strategy" | "scope" | "handoff";

export type ActionRequest =
  /** design は計画の承認だけ。設計の段で動かす役割の、人による上書き */
  /** targetProject は引き渡しの承認だけ(フェーズ9。開発のタスクを作るプロジェクト。既定は企画のプロジェクト) */
  | { action: "approve"; kind: ApprovalKindView; comment?: string; design?: DesignOptions; split?: boolean; targetProject?: string; devProject?: { repoPath: string; name?: string } }
  | { action: "reject"; kind: ApprovalKindView; comment: string }
  | { action: "answer"; message: string }
  /** デザインレビューで止まったとき(撮影できないなど)の出口。comment は任意 */
  | { action: "skip_design_review"; comment?: string }
  | { action: "back_to_implementer"; comment: string }
  | { action: "stop" }
  | { action: "takeover" }
  | { action: "return" }
  | { action: "cancel" }
  /** 振り返りの提案を採用・却下する(8-5) */
  | { action: "retro"; index: number; adopt: boolean }
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
  /** 計画の承認で選べる「分割して進める」(8-2。プランナーが分割を提案したときだけ)。選んだら request.split を true にして送る */
  split?: { count: number; titles: string[] };
  /** 引き渡しの承認で選べる、開発のタスクを作るプロジェクト(9a。リポジトリのあるもの)。選んだら request.targetProject に入れて送る */
  /** attachTo: リポジトリの無い企画のプロジェクト。リポジトリを足して開発に使うか、別のプロジェクトを作れる(request.devProject) */
  targets?: { projects: string[]; selected: string | null; attachTo?: string };
};

/** quota は利用枠による自動の一時停止(7-1。リセットの時刻を過ぎたら自動で動く) */
export type WorkerView = { state: "running" | "paused" | "locked" | "disabled"; active: number[]; quota?: { until: number; window: string; reason: string } };

/** 利用枠の最新の値(7-1。claude の rate_limit から) */
export type UsageView = { status: string; updatedAt: number; windows: { key: string; label: string; utilization: number; resetsAt: number }[] };

/** kind が planning なら企画のタスク(フェーズ9)。docs は読ませる手元の資料(絶対パス) */
export type CreateTaskRequest = { projectId: number; title: string; body: string; sourceUrl?: string; kind?: "normal" | "planning"; docs?: string[] };

export type ActionResult = { message: string; task: TaskSummary };

export type ProjectSummary = {
  id: number;
  name: string;
  profileStatus: string;
  testInfra: string;
  allowWithoutTests: boolean;
  /** リポジトリの数。0 なら企画用のプロジェクト(フェーズ9) */
  repoCount: number;
  /** 完了・取り消し以外のタスクの数 */
  activeTasks: number;
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
  kind: "normal" | "test_infra" | "planning";
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
  /** 費用が記録された実行の合計。1つも無ければ null */
  costUsd: number | null;
  /** 進め方(フェーズ10)。fixed は固定の流れ、coordinator は LLM のコーディネーター */
  flow: "fixed" | "coordinator";
  /** コーディネーターで進める企画の、最後に書いた段(p_researching など)。パイプラインの現在地に使う。無ければ null */
  flowStage: TaskState | null;
};

export type Overview = {
  worker: WorkerView;
  usage: UsageView | null;
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

/** removed: 完了・取り消しで片付け済み(ブランチは残っている。7-2) */
export type WorktreeView = { repoRole: string; worktreePath: string; branchName: string; baseSha: string; removed: boolean };

/** 実装後のデザインレビューのために撮った画面(4c)。撮れなかったものは url が null で、error に理由 */
/** device は iOS シミュレータで撮ったときの機種(フェーズ6。そのときは幅の代わりに出す) */
export type ScreenshotView = { name: string; path: string; width: number; scheme: "light" | "dark"; file: string; device?: string; url: string | null; error?: string };

/** Notion などに貼る報告(6c。投稿は人が行う) */
export type TaskReportView = {
  taskId: number;
  title: string;
  sourceUrl: string | null;
  sections: { id: "summary" | "criteria" | "qa" | "design" | "pr"; title: string; markdown: string }[];
  markdown: string;
};

export type TaskDetail = {
  task: TaskSummary & { body: string; sourceKind: string; sourceUrl: string | null };
  project: ProjectSummary;
  worktrees: WorktreeView[];
  approvals: ApprovalView[];
  artifacts: ArtifactSummary[];
  runs: RunSummary[];
  /** costUsd は一覧の TaskSummary.costUsd と同じ(費用が記録された実行の合計。無ければ null) */
  totals: { costUsd: number | null; durationSec: number };
  nextActions: NextAction[];
  runActive: boolean;
  /** 最新の撮影の画面(デザインレビューの判断材料。無ければ空) */
  screenshots: ScreenshotView[];
  report: TaskReportView;
  /** 振り返りの提案と人の判断(8-5)。振り返りが無ければ null */
  retro: { proposals: { index: number; target: "conventions" | "decisions"; text: string; status: "pending" | "adopted" | "rejected" }[] } | null;
  /** 企画の承認で人が決めること(フェーズ9。問いを1件ずつ)。無ければ null */
  planningQuestions: { stage: string; questions: { from: string; text: string }[]; musts: string[]; shoulds: number } | null;
  /** 最終確認の材料のうち、成果物として登録しないファイル(差分、テストの変更の検出結果)の URL。無ければ null */
  reviewFiles: { diff: string | null; testChanges: string | null };
  /** 分割の親(8-2)。子でなければ null */
  parent: { id: number; title: string } | null;
  /** 分割した子タスク(順番どおり)。親でなければ空 */
  children: { id: number; title: string; seq: number; state: TaskState; stateLabel: string }[];
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
  /** リポジトリごとのプロファイル(役割に渡すコマンド)と、起動のつなぎ方の環境変数(フェーズ5) */
  repos: { id: number; path: string; role: string; defaultBranch: string; profile: unknown; env: Record<string, string>; protect: string[] }[];
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
