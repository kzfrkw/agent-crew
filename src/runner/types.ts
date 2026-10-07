/**
 * エージェント実行の抽象。いまは claude -p(ClaudeRunner)だけだが、
 * 後から Agent SDK に差し替えられるよう、呼び出し側はこの型だけに依存する。
 */

/** 役割の書き込み範囲(roles/*.md の permissions.write) */
export type WriteScope = "none" | "artifacts" | "worktree";

export type RunSpec = {
  /** 作業ディレクトリ(タスクのworktree) */
  cwd: string;
  /** settings.json・プロンプト・生のストリームを残す場所 */
  runDir: string;
  /** 成果物ディレクトリ(--add-dir で渡し、ここには常に書ける) */
  artifactsDir: string;
  /** タスク固有の入力。標準入力で渡す */
  prompt: string;
  /** 役割のプロンプト。--append-system-prompt で渡す */
  systemPromptAppend: string;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  tools: string[];
  write: WriteScope;
  /** write が artifacts でも、Bash からのビルド・テストのために worktree への書き込みを許す(QA・プロジェクト把握担当) */
  bashWritesWorktree?: boolean;
  /** 判定のJSONスキーマ(--json-schema) */
  jsonSchema: object;
  timeoutSec: number;
  maxBudgetUsd: number;
  allowedDomains: string[];
  /** 追加で渡す環境変数(認証情報は渡せない) */
  extraEnv?: Record<string, string>;
  resumeSessionId?: string;
};

export type RunEvent = { kind: string; payload: unknown };

export type PermissionDenial = { tool: string; input: unknown };

export type RunResult = {
  status: "succeeded" | "failed" | "timeout";
  structuredOutput?: unknown;
  resultText?: string;
  sessionId?: string;
  costUsd?: number;
  models: string[];
  permissionDenials: PermissionDenial[];
  error?: string;
  durationMs: number;
};

export interface Runner {
  run(spec: RunSpec, onEvent: (e: RunEvent) => void): Promise<RunResult>;
}
