import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { configPath, dataHome, loadConfig } from "../config/config.ts";
import { appDbPath } from "../app.ts";
import { openDb } from "../db/connection.ts";
import { getRepoProtect, listProjects, listRepos } from "../db/store.ts";
import type { Db } from "../db/connection.ts";
import { runChecks, type CheckResult, type Probe } from "./checks.ts";
import { runProbe } from "./probe.ts";

function systemProbe(claudePath: string): Probe {
  return {
    env: process.env,
    nodeVersion: process.versions.node,
    platform: process.platform,
    claudePath,
    exists: existsSync,
    run(cmd, args) {
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000 });
      return { ok: r.status === 0, stdout: r.stdout ?? "" };
    },
  };
}

export function doctor(): CheckResult[] {
  const home = dataHome();
  let claudePath = "claude";
  let configResult: CheckResult;
  try {
    const config = loadConfig(home);
    claudePath = config.claudePath;
    configResult = {
      id: "config",
      level: "ok",
      message: existsSync(configPath(home)) ? `設定: ${configPath(home)}` : `設定ファイルなし(既定値を使用): ${configPath(home)}`,
    };
  } catch (e) {
    configResult = { id: "config", level: "error", message: (e as Error).message };
  }
  return [configResult, ...runChecks(systemProbe(claudePath)), ...registeredRepos(home)];
}

/** 登録済みのリポジトリの点検(7-5)。データベースを開いて repoChecks を行う */
function registeredRepos(home: string): CheckResult[] {
  if (!existsSync(appDbPath(home))) return [];
  const db = openDb(appDbPath(home));
  try {
    return repoChecks(db);
  } finally {
    db.close();
  }
}

/**
 * 登録済みのリポジトリごとの点検: リポジトリがあるか、worktree を作るときのローカル設定、
 * リポジトリ側の .claude/settings.json と .mcp.json(エージェントの実行では読み込まない)、読ませないパスの設定(会社のリポジトリなら設定を勧める)
 */
export function repoChecks(db: Db): CheckResult[] {
  return listProjects(db).flatMap((p) =>
    listRepos(db, p.id).flatMap((r): CheckResult[] => {
      const id = `repo:${p.name}/${r.role}`;
      if (!existsSync(join(r.path, ".git"))) return [{ id, level: "error", message: `${r.path}: リポジトリが見つかりません(移動したら登録し直してください)` }];
      const protect = getRepoProtect(db, r.id);
      return [
        { id, level: "info", message: `${r.path}: ローカル設定 extensions.worktreeConfig=true を使用(エージェントのworktreeだけに pre-push を効かせるため)` },
        ...(existsSync(join(r.path, ".claude", "settings.json"))
          ? [{ id: `${id}:claude-settings`, level: "info" as const, message: `${r.path}/.claude/settings.json があります。エージェントの実行では読み込みません(--setting-sources "")。人が Claude Code を使うときは、中のフックや許可を確認してください` }]
          : []),
        ...(existsSync(join(r.path, ".mcp.json"))
          ? [{ id: `${id}:mcp`, level: "info" as const, message: `${r.path}/.mcp.json があります。エージェントの実行では読み込みません(--strict-mcp-config)` }]
          : []),
        protect.length
          ? { id: `${id}:protect`, level: "ok" as const, message: `読ませないパス: ${protect.join("、")}` }
          : { id: `${id}:protect`, level: "info" as const, message: `読ませないパスが未設定です。鍵や本番の設定、顧客データがあれば agent-crew project protect ${p.name} --add <パス> で足してください` },
      ];
    }),
  );
}

/** 実際に claude -p を動かす安全設定の検査(利用枠を少し使う) */
export async function probeSandbox(): Promise<CheckResult[]> {
  const home = dataHome();
  const config = loadConfig(home);
  return runProbe({ home, claudePath: config.claudePath, allowedDomains: config.sandbox.allowedDomains });
}

const MARK = { ok: "✓", info: "i", warn: "!", error: "✗" } as const;

export function formatResults(results: CheckResult[]): string {
  return results.map((r) => `${MARK[r.level]} [${r.id}] ${r.message}`).join("\n");
}
