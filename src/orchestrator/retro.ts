import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/connection.ts";
import { addEvent, getProjectSettings, getRepoProfile, getTask, listEvents, listRepos, setProjectProfile, setRepoProfile, type Task } from "../db/store.ts";
import type { Profile } from "../roles/schemas.ts";
import type { AppContext } from "./context.ts";
import { invokeRole } from "./invoke.ts";
import { projectDir, taskDir } from "./paths.ts";
import { taskPrompt } from "./prompts.ts";
import { QuotaError } from "./usage.ts";

/**
 * 振り返り(設計メモ v0.18、8-5)。タスクが完了したら一度だけ動かし、規約・設計判断ログへの追記を提案させる。
 * 書き足すのは、人が採用したものだけ(ツールが行う。エージェントはプロジェクトの領域に書かない)。タスクの状態は変えない
 */

export type RetroProposal = { index: number; target: "conventions" | "decisions"; text: string; status: "pending" | "adopted" | "rejected" };

/** 完了したときに、振り返りを待つ印を付ける(プロジェクトでオフでなければ。分割の親は子が振り返るので付けない) */
export function markRetroPending(ctx: AppContext, task: Task): void {
  if (getProjectSettings(ctx.db, task.projectId).retrospective === false) return;
  if (listEvents(ctx.db, task.id, 2000).some((e) => e.kind === "state_changed" && (e.payload as { to?: string }).to === "split")) return;
  addEvent(ctx.db, { taskId: task.id, kind: "retro_pending", payload: {} });
}

/** 振り返りを待っているか(印があり、まだ動かしていない) */
export function retroPending(db: Db, taskId: number): boolean {
  const kinds = listEvents(db, taskId, 2000).map((e) => e.kind);
  return kinds.includes("retro_pending") && !kinds.includes("retro_done");
}

/** 振り返りを1回動かす。成否に関わらず、やり直さない(retro_done を残す) */
export async function runRetro(ctx: AppContext, task: Task): Promise<void> {
  const dir = taskDir(ctx.home, task.id);
  mkdirSync(dir, { recursive: true });
  try {
    const r = await invokeRole(ctx, { roleName: "retrospective", taskId: task.id, cwd: dir, artifactsDir: dir, prompt: taskPrompt(ctx, task, "retrospective") });
    if (r.ok) {
      const proposals = ((r.extra.proposals ?? []) as { target: RetroProposal["target"]; text: string }[]).filter((p) => p.text?.trim()).slice(0, 5);
      addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "retro", payload: { proposals } });
    }
  } catch (e) {
    // 利用枠の上限なら、リセットの後にやり直す(印を残さない)。それ以外は警告にして、やり直さない
    if (e instanceof QuotaError) throw e;
    addEvent(ctx.db, { taskId: task.id, kind: "warning", payload: { message: `振り返りに失敗しました: ${(e as Error).message}` } });
  }
  addEvent(ctx.db, { taskId: task.id, kind: "retro_done", payload: {} });
}

/** 提案と、人の判断。振り返りが無ければ null */
export function retroView(db: Db, taskId: number): { proposals: RetroProposal[] } | null {
  const events = listEvents(db, taskId, 2000);
  const retro = events.filter((e) => e.kind === "retro").at(-1);
  if (!retro) return null;
  const decided = new Map<number, RetroProposal["status"]>();
  for (const e of events.filter((x) => x.kind === "retro_decision" && x.id > retro.id)) {
    const p = e.payload as { index: number; adopt: boolean };
    decided.set(p.index, p.adopt ? "adopted" : "rejected");
  }
  const proposals = (retro.payload as { proposals: { target: RetroProposal["target"]; text: string }[] }).proposals;
  return { proposals: proposals.map((p, index) => ({ index, target: p.target, text: p.text, status: decided.get(index) ?? "pending" })) };
}

/**
 * 提案を採用・却下する。採用したら、規約はプロファイル(全リポジトリと、プロジェクト全体)に、判断は decisions.md に書き足す。
 * 一度決めたものは変えない(force なら、却下したものを採用し直せる)
 */
export function decideRetro(ctx: AppContext, taskId: number, index: number, adopt: boolean, o: { force?: boolean } = {}): void {
  const task = getTask(ctx.db, taskId);
  if (!task) throw new Error(`タスク ${taskId} がありません`);
  const view = retroView(ctx.db, taskId);
  const p = view?.proposals[index];
  if (!p) throw new Error(`振り返りの提案 ${index} がありません`);
  if (p.status !== "pending" && !(o.force && p.status === "rejected" && adopt)) throw new Error(`提案 ${index} はすでに決まっています(${p.status === "adopted" ? "採用" : "却下"})`);
  if (adopt) {
    if (p.target === "conventions") {
      for (const [i, repo] of listRepos(ctx.db, task.projectId).entries()) {
        const prof = getRepoProfile(ctx.db, repo.id) as Profile | null;
        if (!prof) continue;
        const next = { ...prof, conventions: `${prof.conventions.trim()}\n- ${p.text}(#${task.id} の振り返り)`.trim() };
        setRepoProfile(ctx.db, repo.id, next);
        if (i === 0) setProjectProfile(ctx.db, task.projectId, { profile: next });
      }
    } else {
      const dir = projectDir(ctx.home, task.projectId);
      mkdirSync(dir, { recursive: true });
      const now = new Date();
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      appendFileSync(join(dir, "decisions.md"), `\n## ${day} #${task.id} ${task.title}(振り返り)\n\n- ${p.text}\n`);
    }
  }
  addEvent(ctx.db, { taskId, kind: "retro_decision", payload: { index, adopt, target: p.target, text: p.text } });
}
