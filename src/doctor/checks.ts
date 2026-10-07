import { compareVersions, extractVersion } from "../util/version.ts";

export const MIN_NODE_MAJOR = 24;
/** --setting-sources "" やサンドボックスの「管理者必須」の挙動を確認した版(docs/safety.md) */
export const MIN_CLAUDE_VERSION = "2.1.285";

export type Level = "ok" | "info" | "warn" | "error";
export type CheckResult = { id: string; level: Level; message: string };

/** 外部の状態を読む口。テストでは差し替える */
export type Probe = {
  env: Record<string, string | undefined>;
  nodeVersion: string;
  platform: NodeJS.Platform;
  claudePath: string;
  run(cmd: string, args: string[]): { ok: boolean; stdout: string };
  exists(path: string): boolean;
};

/** 無くても起動はできるが、対応する機能が無効になる道具 */
const OPTIONAL_TOOLS = [
  { cmd: "xcodebuild", args: ["-version"], feature: "iOSのビルドとQA(フェーズ6)" },
  { cmd: "flutter", args: ["--version"], feature: "FlutterのテストとQA(フェーズ6)" },
  { cmd: "maestro", args: ["--version"], feature: "モバイルUIの自動操作(フェーズ6)" },
];

/** エージェントには渡さない認証情報(docs/safety.md 4章) */
const GITHUB_CREDENTIAL_VARS = ["GITHUB_TOKEN", "GH_TOKEN", "SSH_AUTH_SOCK"];

export function runChecks(p: Probe): CheckResult[] {
  return [
    checkNode(p),
    checkGit(p),
    checkClaude(p),
    checkAuth(p),
    checkApiKey(p),
    checkGithubCredentials(p),
    checkSandbox(p),
    ...OPTIONAL_TOOLS.map((t) => checkOptionalTool(p, t)),
  ];
}

function checkNode(p: Probe): CheckResult {
  const major = Number(p.nodeVersion.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    return { id: "node", level: "error", message: `Node ${p.nodeVersion}: ${MIN_NODE_MAJOR} 以上が必要です` };
  }
  if (major % 2 === 1) {
    return { id: "node", level: "warn", message: `Node ${p.nodeVersion}: LTSではない版です。Node ${MIN_NODE_MAJOR} LTS を推奨します` };
  }
  return { id: "node", level: "ok", message: `Node ${p.nodeVersion}` };
}

function checkGit(p: Probe): CheckResult {
  const r = p.run("git", ["--version"]);
  if (!r.ok) return { id: "git", level: "error", message: "git が見つかりません" };
  return { id: "git", level: "ok", message: r.stdout.trim() };
}

function checkClaude(p: Probe): CheckResult {
  const r = p.run(p.claudePath, ["--version"]);
  const v = r.ok ? extractVersion(r.stdout) : undefined;
  if (!v) return { id: "claude", level: "error", message: `Claude Code(${p.claudePath})が見つかりません` };
  if (compareVersions(v, MIN_CLAUDE_VERSION) < 0) {
    return { id: "claude", level: "error", message: `Claude Code ${v}: ${MIN_CLAUDE_VERSION} 以上が必要です(claude update)` };
  }
  return { id: "claude", level: "ok", message: `Claude Code ${v}` };
}

function checkAuth(p: Probe): CheckResult {
  const r = p.run(p.claudePath, ["auth", "status"]);
  let s: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string } = {};
  try {
    s = JSON.parse(r.stdout);
  } catch {
    // 読めなければ未ログイン扱い
  }
  if (!r.ok || !s.loggedIn) {
    return { id: "auth", level: "error", message: "Claude Code にログインしていません(claude auth login)" };
  }
  if (s.authMethod !== "claude.ai") {
    return {
      id: "auth",
      level: "warn",
      message: `認証方式: ${s.authMethod ?? "不明"}。サブスク(claude.ai)以外は従量課金になる可能性があります`,
    };
  }
  return { id: "auth", level: "ok", message: `認証方式: サブスク(claude.ai、プラン: ${s.subscriptionType ?? "不明"})` };
}

function checkApiKey(p: Probe): CheckResult {
  if (p.env.ANTHROPIC_API_KEY) {
    return {
      id: "anthropic-api-key",
      level: "warn",
      message: "ANTHROPIC_API_KEY が設定されています。APIの従量課金になる可能性があります。エージェントには渡しませんが、不要なら外してください",
    };
  }
  return { id: "anthropic-api-key", level: "ok", message: "ANTHROPIC_API_KEY は未設定" };
}

function checkGithubCredentials(p: Probe): CheckResult {
  const found = GITHUB_CREDENTIAL_VARS.filter((k) => p.env[k]);
  if (found.length === 0) {
    return { id: "github-credentials", level: "ok", message: "GitHubの認証情報は環境変数にありません" };
  }
  return {
    id: "github-credentials",
    level: "info",
    message: `${found.join(", ")} が設定されています。エージェントの実行環境には渡しません`,
  };
}

function checkSandbox(p: Probe): CheckResult {
  const bin = p.platform === "darwin" ? "/usr/bin/sandbox-exec" : p.platform === "linux" ? "bwrap" : undefined;
  if (!bin) {
    return { id: "sandbox", level: "error", message: `${p.platform} ではサンドボックスを使えません(macOS / Linux / WSL2 が必要)` };
  }
  const available = p.platform === "darwin" ? p.exists(bin) : p.run("which", [bin]).ok;
  if (!available) {
    return { id: "sandbox", level: "error", message: `サンドボックスに必要な ${bin} が見つかりません` };
  }
  return { id: "sandbox", level: "ok", message: `サンドボックスを使えます(${bin})` };
}

function checkOptionalTool(p: Probe, t: (typeof OPTIONAL_TOOLS)[number]): CheckResult {
  const r = p.run(t.cmd, t.args);
  const id = `tool:${t.cmd}`;
  if (!r.ok) return { id, level: "info", message: `${t.cmd} が無いため無効: ${t.feature}` };
  return { id, level: "ok", message: `${t.cmd}: ${r.stdout.trim().split("\n")[0]}` };
}
