import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/connection.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** オーケストレーターの実行(agent-crew run)を1つに限る。戻り値はロックを外す関数 */
export function acquireRunLock(home: string): () => void {
  mkdirSync(home, { recursive: true });
  const path = join(home, "run.lock");
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8").trim());
    if (pid && alive(pid)) throw new Error(`別の agent-crew run が実行中です(pid ${pid})`);
  }
  writeFileSync(path, String(process.pid));
  return () => {
    if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path);
  };
}

/** 前回の実行が中断されて running のまま残った記録を failed にする(ロックを取った後に呼ぶ) */
export function recoverStaleRuns(db: Db): number {
  const r = db
    .prepare("UPDATE runs SET state = 'failed', error = '前回の実行が中断されました', ended_at = ? WHERE state = 'running'")
    .run(new Date().toISOString());
  return Number(r.changes);
}
