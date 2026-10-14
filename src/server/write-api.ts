import { spawn } from "node:child_process";
import { createTask, getProject, getProjectByName, getTask, listTaskRepos } from "../db/store.ts";
import type { AppContext } from "../orchestrator/context.ts";
import { requestStop } from "../orchestrator/engine.ts";
import { returnTask, takeoverTask, updateBase } from "../orchestrator/handoff.ts";
import { answerTask, approveTask, cancelTask, rejectTask } from "../orchestrator/human.ts";
import { decideRetro } from "../orchestrator/retro.ts";
import { createPlanningProject, createPlanningTask } from "../orchestrator/planning.ts";
import type { Worker } from "../orchestrator/worker.ts";
import type { ActionRequest, ApprovalKindView, ProjectSummary, ActionResult, CreateTaskRequest, DesignOptions, TaskSummary, WorkerView } from "./api-types.ts";
import { HttpError, projectSummary, taskSummaryOf } from "./api.ts";

/**
 * 書き込み API(docs/structure.md「フェーズ3」)。人の操作は CLI と同じ関数を通し、
 * 状態遷移の正しさは transitions.ts に任せる(受け付けない操作は 409 と理由)。
 */

export type Ops = { ctx: AppContext; worker?: Worker };

export function workerView(worker: Worker | undefined): WorkerView {
  return worker ? worker.status() : { state: "disabled", active: [] };
}

export async function handleWrite(ops: Ops, path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  if (path === "tasks") return { status: 201, data: { task: createTicket(ops, body) } };
  if (path === "worker") return { status: 200, data: await toggleWorker(ops, body) };
  if (path === "projects") return { status: 201, data: { project: createProjectFromGui(ops, body) } };
  const m = /^tasks\/(\d+)\/actions$/.exec(path);
  if (m) return { status: 200, data: await act(ops, Number(m[1]), body) };
  throw new HttpError(404, "ありません");
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, name: string): string => {
  if (typeof v !== "string") throw new HttpError(400, `${name} を文字列で指定してください`);
  return v;
};

function createTicket(ops: Ops, body: unknown): TaskSummary {
  if (!isObject(body)) throw new HttpError(400, "本文は JSON のオブジェクトで送ってください");
  const req = body as Partial<CreateTaskRequest>;
  const title = str(req.title, "title").trim();
  if (!title) throw new HttpError(400, "タイトルを書いてください");
  if (title.length > 200) throw new HttpError(400, "タイトルは200文字以内にしてください");
  const text = req.body === undefined ? "" : str(req.body, "body");
  const project = typeof req.projectId === "number" ? getProject(ops.ctx.db, req.projectId) : undefined;
  if (!project) throw new HttpError(400, "プロジェクトがありません");
  let sourceUrl: string | undefined;
  if (req.sourceUrl !== undefined && req.sourceUrl !== "") {
    sourceUrl = str(req.sourceUrl, "sourceUrl").trim();
    if (!/^https?:\/\//.test(sourceUrl)) throw new HttpError(400, "取り込み元の URL は http(s) で指定してください");
  }
  let t;
  if (req.kind === "planning") {
    const docs = Array.isArray(req.docs) ? req.docs.map((d) => str(d, "docs").trim()).filter(Boolean) : [];
    try {
      t = createPlanningTask(ops.ctx, { projectName: project.name, title, body: text, docs, sourceUrl });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  } else {
    t = createTask(ops.ctx.db, { projectId: project.id, title, body: text, sourceKind: sourceUrl ? "paste" : "local", sourceUrl });
  }
  ops.worker?.kick();
  return taskSummaryOf(ops.ctx.db, t.id)!;
}

/** 企画用のプロジェクト(リポジトリなし)を作る(フェーズ9)。リポジトリの登録は、ローカルのパスを扱うため CLI のまま */
function createProjectFromGui(ops: Ops, body: unknown): ProjectSummary {
  if (!isObject(body)) throw new HttpError(400, "本文は JSON のオブジェクトで送ってください");
  const name = str(body.name, "name").trim();
  if (!name) throw new HttpError(400, "名前を書いてください");
  try {
    createPlanningProject(ops.ctx, name);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  return projectSummary(getProjectByName(ops.ctx.db, name)!);
}

async function toggleWorker(ops: Ops, body: unknown): Promise<WorkerView> {
  if (!ops.worker) throw new HttpError(409, "自動実行なし(--no-worker)で起動しています");
  if (!isObject(body) || typeof body.paused !== "boolean") throw new HttpError(400, "paused を true / false で指定してください");
  // 一時停止は、実行中の役割の終了を待たずに返す(ロックは終わったときに外れる)
  if (body.paused) void ops.worker.pause();
  else ops.worker.resume();
  return workerView(ops.worker);
}

const ACTIONS = ["approve", "reject", "answer", "stop", "takeover", "return", "cancel", "update_base", "open_editor", "retro"];

async function act(ops: Ops, taskId: number, body: unknown): Promise<ActionResult> {
  const { ctx, worker } = ops;
  if (!getTask(ctx.db, taskId)) throw new HttpError(404, "タスクがありません");
  if (!isObject(body) || typeof body.action !== "string" || !ACTIONS.includes(body.action)) throw new HttpError(400, "知らない操作です");
  const req = body as ActionRequest;
  const kind = () => {
    const k = (req as { kind?: unknown }).kind;
    if (!["plan", "design", "final", "strategy", "scope", "handoff"].includes(String(k))) throw new HttpError(400, "kind は plan / design / final / strategy / scope / handoff です");
    return k as ApprovalKindView;
  };
  const required = (v: unknown, what: string) => {
    if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${what}を書いてください`);
    return v;
  };

  let message: string;
  try {
    switch (req.action) {
      case "approve": {
        const comment = typeof req.comment === "string" && req.comment.trim() ? req.comment : undefined;
        let design: DesignOptions | undefined;
        if (req.design !== undefined) {
          const d = req.design as Partial<Record<string, unknown>>;
          if (typeof d?.architect !== "boolean" || typeof d?.designer !== "boolean") throw new HttpError(400, "design は { architect, designer } を true / false で指定してください");
          design = { architect: d.architect, designer: d.designer };
        }
        approveTask(ctx, taskId, kind(), comment, design, { split: req.split === true, targetProject: typeof req.targetProject === "string" && req.targetProject ? req.targetProject : undefined });
        message = "承認しました";
        break;
      }
      case "reject":
        rejectTask(ctx, taskId, kind(), required(req.comment, "却下の理由"));
        message = "差し戻しました";
        break;
      case "answer":
        answerTask(ctx, taskId, required(req.message, "回答"));
        message = "回答しました";
        break;
      case "stop":
        if (!requestStop(ctx, taskId)) {
          throw new HttpError(409, "このサーバーが動かしている実行ではありません。CLI の agent-crew run で動かしているなら、そちらを Ctrl-C で止めてください");
        }
        message = "停止を指示しました";
        break;
      case "takeover":
        takeoverTask(ctx, taskId);
        message = "引き取りました。worktree で作業し、変更はコミットしてください";
        break;
      case "return": {
        const r = returnTask(ctx, taskId);
        message = r.humanChanged ? `戻しました。人の変更 ${r.commits.length} 件を記録し、レビューからやり直します` : "戻しました";
        break;
      }
      case "cancel":
        cancelTask(ctx, taskId);
        message = "取り消しました";
        break;
      case "retro": {
        if (typeof req.index !== "number" || typeof req.adopt !== "boolean") throw new HttpError(400, "index(数)と adopt(true / false)を指定してください");
        decideRetro(ctx, taskId, req.index, req.adopt, { force: true });
        message = req.adopt ? "採用し、書き足しました" : "却下しました";
        break;
      }
      case "update_base":
        message = updateBase(ctx, taskId).message;
        break;
      case "open_editor":
        await openEditor(ctx, taskId);
        message = "エディタで開きました";
        break;
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // 状態遷移で受け付けない、未コミットの変更がある、など。人が読める理由を返す
    throw new HttpError(409, (e as Error).message);
  }
  worker?.kick();
  return { message, task: taskSummaryOf(ctx.db, taskId)! };
}

/** 設定のエディタを、引数に worktree のパスだけを渡して起動する(シェルは通さない) */
function openEditor(ctx: AppContext, taskId: number): Promise<void> {
  const paths = listTaskRepos(ctx.db, taskId).map((tr) => tr.worktreePath);
  if (paths.length === 0) throw new HttpError(409, "worktree がまだありません");
  return new Promise((resolve, reject) => {
    const child = spawn(ctx.config.editor, paths, { detached: true, stdio: "ignore" });
    child.once("error", (e) => reject(new HttpError(409, `エディタ(${ctx.config.editor})を起動できません: ${e.message}。config.json の editor を確認してください`)));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
