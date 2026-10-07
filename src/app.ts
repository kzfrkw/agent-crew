import { join } from "node:path";
import { dataHome } from "./config/config.ts";
import { openDb, type Db } from "./db/connection.ts";

/** データディレクトリ内の DB の場所 */
export function appDbPath(home: string): string {
  return join(home, "agent-crew.db");
}

export function openAppDb(home: string = dataHome()): Db {
  return openDb(appDbPath(home));
}
