import { mkdirSync, realpathSync } from "node:fs";
import { openAppDb } from "../app.ts";
import { dataHome, loadConfig, type Config } from "../config/config.ts";
import type { Db } from "../db/connection.ts";
import { applyRoleOverrides, loadRoles, type RoleDef } from "../roles/roles.ts";
import { ClaudeRunner } from "../runner/claude.ts";
import type { Runner } from "../runner/types.ts";
import type { Shot } from "../browser/chrome.ts";
import type { Task } from "../db/store.ts";
import type { ToolExecFn } from "../toolexec/command.ts";
import type { Simctl } from "../mobile/simulator.ts";
import type { Notifier } from "./notify.ts";

export type ScreenRequest = { path: string; note?: string };
/** タスクの worktree のアプリを起動して画面を撮り、outDir に PNG を置く(設計メモ v0.13) */
export type CaptureFn = (ctx: AppContext, task: Task, o: { worktree: string; outDir: string; screens: ScreenRequest[] }) => Promise<Shot[]>;

/** オーケストレーターが使う依存一式。テストでは DB をメモリに、ランナーを台本に差し替える */
export type AppContext = {
  db: Db;
  home: string;
  config: Config;
  roles: Map<string, RoleDef>;
  runner: Runner;
  /** ツール自身が実行する git の環境変数 */
  gitEnv: NodeJS.ProcessEnv;
  /** 画面の撮影(4c)。テストでは実際の Chrome を使わない関数に差し替える。無ければ screens.ts の既定 */
  capture?: CaptureFn;
  /** ツールが代わりに実行するコマンド(Flutter のテストなど。フェーズ6)。テストでは差し替える。無ければ toolexec の既定(sandbox-exec) */
  toolExec?: ToolExecFn;
  /** xcrun simctl(フェーズ6)。テストでは差し替える。無ければ mobile/simulator の既定 */
  simctl?: Simctl;
  /** 人の対応待ちの通知(7-3)。テストでは差し替える。無ければ macOS の通知 */
  notifier?: Notifier;
  /** 進めている最中のタスクの、停止の合図(stepTask が作る。requestStop で鳴らす) */
  stops?: Map<number, AbortController>;
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
