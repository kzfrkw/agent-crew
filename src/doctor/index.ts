import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { configPath, dataHome, loadConfig } from "../config/config.ts";
import { appDbPath } from "../app.ts";
import { openDb } from "../db/connection.ts";
import { listProjects, listRepos } from "../db/store.ts";
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

/** 登録済みのリポジトリ。worktree を作るときにローカル設定(extensions.worktreeConfig)を1つ変えることを知らせる */
function registeredRepos(home: string): CheckResult[] {
  if (!existsSync(appDbPath(home))) return [];
  const db = openDb(appDbPath(home));
  try {
    return listProjects(db).flatMap((p) =>
      listRepos(db, p.id).map((r) => ({
        id: `repo:${p.name}/${r.role}`,
        level: "info" as const,
        message: `${r.path}: ローカル設定 extensions.worktreeConfig=true を使用(エージェントのworktreeだけに pre-push を効かせるため)`,
      })),
    );
  } finally {
    db.close();
  }
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
