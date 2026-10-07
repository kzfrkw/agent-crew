import { mkdirSync, realpathSync } from "node:fs";
import { openAppDb } from "../app.ts";
import { dataHome, loadConfig, type Config } from "../config/config.ts";
import type { Db } from "../db/connection.ts";
import { applyRoleOverrides, loadRoles, type RoleDef } from "../roles/roles.ts";
import { ClaudeRunner } from "../runner/claude.ts";
import type { Runner } from "../runner/types.ts";

/** オーケストレーターが使う依存一式。テストでは DB をメモリに、ランナーを台本に差し替える */
export type AppContext = {
  db: Db;
  home: string;
  config: Config;
  roles: Map<string, RoleDef>;
  runner: Runner;
  /** ツール自身が実行する git の環境変数 */
  gitEnv: NodeJS.ProcessEnv;
};

export function createAppContext(dataDir: string = dataHome()): AppContext {
  // 実体のパスにそろえる(権限ルールはシンボリックリンクを解決せずに照合するため)
  mkdirSync(dataDir, { recursive: true });
  const home = realpathSync(dataDir);
  const config = loadConfig(home);
  return {
    db: openAppDb(home),
    home,
    config,
    roles: applyRoleOverrides(loadRoles(), config.roles),
    runner: new ClaudeRunner({ claudePath: config.claudePath }),
    gitEnv: process.env,
  };
}
