import { addEvent, listEvents, listRepos, listRuns, listTasks, type Task } from "../db/store.ts";
import type { Db } from "../db/connection.ts";
import type { TaskState } from "./states.ts";

/**
 * 同時実行 2 での変更の重なり(設計メモ v0.18、8-4)。同じプロジェクトで、変更の見込みのファイル(計画の expectedFiles)が
 * 重なるタスクが先に進んでいれば、後のタスクの実装を始めない(先のタスクが完了・取り消しになるまで)。
 * 一度実装を始めたタスクは止めない。先後は「すでに実装を始めたか」、どちらも未着手なら番号の小さいほうを先とする
 */

const ACTIVE: TaskState[] = ["implementing", "reviewing", "qa", "design_reviewing", "explaining", "awaiting_final_approval", "integrating"];

const filesOf = (db: Db, taskId: number): string[] =>
  ((listEvents(db, taskId, 2000).filter((e) => e.kind === "plan").at(-1)?.payload as { expectedFiles?: string[] } | undefined)?.expectedFiles ?? []).map((f) =>
    f.replace(/^\.\//, ""),
  );
const started = (db: Db, taskId: number) => listRuns(db, { taskId }).some((r) => r.role === "implementer");
const active = (t: Task) => ACTIVE.includes(t.state) || ((t.state === "needs_input" || t.state === "human_working" || t.state === "failed") && !!t.heldFromState && ACTIVE.includes(t.heldFromState));

/** 実装を始めるのを待たせる相手(無ければ undefined)。待たせるなら一度だけ記録する */
export function overlapBlocker(db: Db, task: Task): Task | undefined {
  if (task.state !== "implementing" || started(db, task.id)) return undefined;
  const mine = new Set(filesOf(db, task.id));
  if (mine.size === 0) return undefined;
  const blocker = listTasks(db, { projectId: task.projectId }).find(
    (o) => o.id !== task.id && active(o) && (o.id < task.id || started(db, o.id)) && filesOf(db, o.id).some((f) => mine.has(f)),
  );
  if (!blocker) return undefined;
  const last = listEvents(db, task.id, 200).filter((e) => e.kind === "waiting_overlap").at(-1)?.payload as { blocker?: number } | undefined;
  if (last?.blocker !== blocker.id) {
    const shared = filesOf(db, blocker.id).filter((f) => mine.has(f));
    addEvent(db, { taskId: task.id, kind: "waiting_overlap", payload: { blocker: blocker.id, files: shared, reason: `#${blocker.id}(${blocker.title})と変更するファイルが重なるため、終わるまで実装を待ちます: ${shared.join("、")}` } });
  }
  return blocker;
}

/**
 * 確認 URL のポートでアプリを起動する段を、同じプロジェクトで2つ同時に進めない(8-4)。
 * デザインレビュー(撮影でプロファイルの起動コマンドを使う)と、複数リポジトリの QA(各リポジトリの確認 URL のポートを使う)。
 * 1リポジトリの QA はタスクごとのポートを使うので対象外
 */
/** inProgress: このプロセスで進めている最中のタスク(撮影は役割の実行の前に行うため、実行の記録だけでは分からない) */
export function appStageBusy(db: Db, task: Task, inProgress: Iterable<number> = []): boolean {
  const usesFixedPorts = (t: Task) => t.state === "design_reviewing" || (t.state === "qa" && listRepos(db, t.projectId).length > 1);
  if (!usesFixedPorts(task)) return false;
  const busy = new Set(inProgress);
  return listTasks(db, { projectId: task.projectId }).some(
    (o) => o.id !== task.id && usesFixedPorts(o) && (busy.has(o.id) || listRuns(db, { taskId: o.id, state: "running" }).length > 0),
  );
}
