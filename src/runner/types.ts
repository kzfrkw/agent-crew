/**
 * エージェント実行の抽象。いまは claude -p(ClaudeRunner)だけだが、
 * 後から Agent SDK に差し替えられるよう、呼び出し側はこの型だけに依存する。
 */

/** 役割の書き込み範囲(roles/*.md の permissions.write) */
export type WriteScope = "none" | "artifacts" | "worktree";

export type RunSpec = {
  /** 役割名(記録用) */
  role: string;
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
  /** QA: 127.0.0.1 でアプリを起動し、接続する */
  localServer?: boolean;
  /** 判定のJSONスキーマ(--json-schema) */
  jsonSchema: object;
  timeoutSec: number;
  maxBudgetUsd: number;
  allowedDomains: string[];
  /**
   * 実行ごとに渡す MCP サーバー(標準入出力)。ツールが代わりにコマンドを実行する橋に使う(フェーズ6)。
   * MCP サーバーは Claude のサンドボックスの外で動くため、ツール自身が書いたものだけを渡す
   */
  mcpServers?: Record<string, { command: string; args: string[] }>;
  /** 読ませないパス(絶対パス。プロジェクトの設定から。7-4) */
  denyRead?: string[];
  /** Bash から追加で書ける場所(道具のキャッシュ。Flutter の SDK の bin/cache、~/.pub-cache など。フェーズ6) */
  extraWritable?: string[];
  /** 書かせないパス(作業場所の中でも。人のリポジトリで直接作業するときの .git/hooks と .git/config。v0.25) */
  denyWrite?: string[];
  /** 追加で許可する道具(MCP の道具。mcp__<サーバー>__<道具>) */
  extraAllowedTools?: string[];
  /** 追加で渡す環境変数(認証情報は渡せない) */
  extraEnv?: Record<string, string>;
  resumeSessionId?: string;
  /** 人による停止の合図。合図が来たら claude を止め、cancelled を返す */
  signal?: AbortSignal;
};

export type RunEvent = { kind: string; payload: unknown };

export type PermissionDenial = { tool: string; input: unknown };

export type RunResult = {
  status: "succeeded" | "failed" | "timeout" | "cancelled";
  structuredOutput?: unknown;
  resultText?: string;
  sessionId?: string;
  costUsd?: number;
  models: string[];
  permissionDenials: PermissionDenial[];
  bashResults: { command: string; isError: boolean; output: string }[];
  error?: string;
  durationMs: number;
};

export interface Runner {
  run(spec: RunSpec, onEvent: (e: RunEvent) => void): Promise<RunResult>;
}
