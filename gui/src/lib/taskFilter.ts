import type { TaskSummary } from "../../../src/server/api-types.ts";

export type Filter = "all" | "active" | "attention";

const CLOSED = ["done", "cancelled"];

/** 一覧に出す行の条件。行の選択と件数の両方がこれを使う */
export function matchesFilter(t: Pick<TaskSummary, "state" | "attention">, filter: Filter, showClosed: boolean): boolean {
  const closed = CLOSED.includes(t.state);
  if (closed && !showClosed) return false;
  if (filter === "all") return true;
  if (filter === "attention") return t.attention !== null;
  return !closed && t.attention === null;
}

/** 各絞り込みを押したときに一覧に出るタスクの件数 */
export function countByFilter(tasks: Pick<TaskSummary, "state" | "attention">[], showClosed: boolean): Record<Filter, number> {
  const count = (f: Filter) => tasks.filter((t) => matchesFilter(t, f, showClosed)).length;
  return { all: count("all"), active: count("active"), attention: count("attention") };
}
