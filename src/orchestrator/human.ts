import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { addApproval, addEvent, createTask, getProject, getTask, listEvents, listRepos, listTaskRepos } from "../db/store.ts";
import { releaseTaskWorktrees } from "./cleanup-worktrees.ts";
import { headSha } from "../git/worktree.ts";
import type { AppContext } from "./context.ts";
import { applyEvent, ensureWorktrees } from "./engine.ts";
import type { DesignPlan, HumanApprovalKind } from "./transitions.ts";
import { getProjectByName, type Project } from "../db/store.ts";
import { prepareDevProject } from "./projects.ts";

/** 引き渡しで用意する開発のプロジェクト(フェーズ9)。name を省くと企画のプロジェクトにリポジトリを足す */
export type DevProjectRequest = { repoPath: string; name?: string };
import { taskDir } from "./paths.ts";

/** 人のコメント・回答。次に起動する役割の入力になる */
export function humanNotesPath(home: string, taskId: number): string {
  return join(taskDir(home, taskId), "human-notes.md");
}

export function appendHumanNote(ctx: AppContext, taskId: number, heading: string, text: string): void {
  mkdirSync(taskDir(ctx.home, taskId), { recursive: true });
  appendFileSync(humanNotesPath(ctx.home, taskId), `\n## ${new Date().toISOString()} ${heading}\n\n${text.trim()}\n`);
}

/** design は計画の承認のときだけ使う(設計の段で動かす役割の、人による上書き) */
/** プランナーが返した分割の案(8-2) */
export function splitProposal(ctx: AppContext, taskId: number): { title: string; body: string }[] {
  const plan = listEvents(ctx.db, taskId, 2000).filter((e) => e.kind === "plan").at(-1)?.payload as { split?: { title: string; body: string }[] } | undefined;
  return (plan?.split ?? []).filter((s) => s.title?.trim());
}

/**
 * 計画を分割して承認する(8-2): 子タスクを作り、親は分割済みにする。1リポジトリのプロジェクトだけ。
 * 親の worktree は使わないので片付ける(子がそれぞれ worktree を作る)
 */
function approveSplit(ctx: AppContext, taskId: number, comment?: string): void {
  const task = getTask(ctx.db, taskId)!;
  const items = splitProposal(ctx, taskId);
  if (items.length < 2) throw new Error("分割の案がありません(プランナーが2つ以上の子タスクを提案したときだけ分割できます)");
  if (listRepos(ctx.db, task.projectId).length > 1) throw new Error("複数リポジトリのプロジェクトのタスクは分割できません");
  applyEvent(ctx, taskId, { type: "split" });
  addApproval(ctx.db, { taskId, kind: "plan", result: "approved", comment: comment ?? "分割して進める" });
  items.forEach((s, i) =>
    createTask(ctx.db, {
      projectId: task.projectId,
      title: s.title,
      body: `${s.body.trim()}\n\n---\n親タスク #${task.id}「${task.title}」を分割した ${i + 1}/${items.length} 番目です。親の計画: ${join(taskDir(ctx.home, task.id), "plan.md")}${i > 0 ? "\n前の子タスクのブランチをベースに作業します。" : ""}`,
      sourceKind: task.sourceKind,
      sourceUrl: task.sourceUrl ?? undefined,
      parentId: task.id,
      seq: i + 1,
    }),
  );
  releaseTaskWorktrees(ctx, taskId);
  if (comment) appendHumanNote(ctx, taskId, "計画の承認コメント(分割)", comment);
}

/**
 * 企画を開発に引き渡す(フェーズ9): まとめ担当のチケットから、開発のタスクを順番つきの子として作る。
 * 引き渡し先は、指定が無ければ企画のプロジェクト。リポジトリの無いプロジェクト(新サービスの企画)には作れない
 */
function approveHandoff(ctx: AppContext, taskId: number, comment: string | undefined, targetProject: string | undefined, devProject: DevProjectRequest | undefined): void {
  const task = getTask(ctx.db, taskId)!;
  const tickets = (listEvents(ctx.db, taskId, 2000).filter((e) => e.kind === "handoff").at(-1)?.payload as { tickets?: { title: string; body: string; acceptanceCriteria?: string[] }[] } | undefined)?.tickets ?? [];
  if (tickets.length === 0) throw new Error("引き渡すチケットがありません(まとめ担当の handoff.md を確認してください)");
  // 状態遷移を受け付けるかを、リポジトリを用意する前に確かめる
  if (task.state !== "awaiting_handoff_approval") throw new Error(`引き渡しの承認待ちではありません(${task.state})`);
  let target: Project | null | undefined;
  if (devProject) {
    // 新サービス: リポジトリを用意して、企画のプロジェクトに足すか、別のプロジェクトを作る(プロファイルは後で作って人が承認する)
    target = prepareDevProject(ctx, { attachTo: getProject(ctx.db, task.projectId)!, name: devProject.name, repoPath: devProject.repoPath });
  } else {
    target = targetProject ? getProjectByName(ctx.db, targetProject) : getProject(ctx.db, task.projectId);
    if (!target) throw new Error(`引き渡し先のプロジェクト ${targetProject} がありません`);
    if (listRepos(ctx.db, target.id).length === 0) {
      throw new Error(`引き渡し先のプロジェクト(${target.name})にリポジトリがありません。リポジトリを登録したプロジェクトを引き渡し先に指定してください(task approve --kind handoff --target <名前>)`);
    }
  }
  applyEvent(ctx, taskId, { type: "approve", kind: "handoff" });
  addApproval(ctx.db, { taskId, kind: "handoff", result: "approved", comment });
  const dir = taskDir(ctx.home, taskId);
  const refs = ["scope.md", "structure.md", "skeleton.md", "strategy.md"].map((f) => join(dir, f));
  tickets.forEach((tk, i) =>
    createTask(ctx.db, {
      projectId: target.id,
      title: tk.title,
      body: [
        tk.body.trim(),
        "",
        "## 受け入れ条件(企画から)",
        ...(tk.acceptanceCriteria ?? []).map((c) => `- ${c}`),
        "",
        "---",
        `企画 #${task.id}「${task.title}」から引き渡された ${i + 1}/${tickets.length} 番目のチケットです。企画の文書(読むだけ): ${refs.join("、")}`,
        ...(i > 0 ? ["前のチケットのブランチをベースに作業します。"] : []),
      ].join("\n"),
      sourceKind: task.sourceKind,
      sourceUrl: task.sourceUrl ?? undefined,
      parentId: task.id,
      seq: i + 1,
    }),
  );
  addEvent(ctx.db, { taskId, kind: "handed_off", payload: { project: target.name, count: tickets.length } });
  if (comment) appendHumanNote(ctx, taskId, "引き渡しの承認コメント", comment);
}

export function approveTask(ctx: AppContext, taskId: number, kind: HumanApprovalKind, comment?: string, design?: DesignPlan, o: { split?: boolean; targetProject?: string; devProject?: DevProjectRequest } = {}): void {
  const task = getTask(ctx.db, taskId);
  if (!task) throw new Error(`タスク ${taskId} がありません`);
  if (kind === "handoff") return approveHandoff(ctx, taskId, comment, o.targetProject, o.devProject);
  if (o.split) {
    if (kind !== "plan") throw new Error("分割できるのは計画の承認だけです");
    approveSplit(ctx, taskId, comment);
    return;
  }
  if (kind === "plan" && task.repos && task.state === "awaiting_plan_approval") {
    // 複数リポジトリ: 2つ以上を変えるなら設計者は必須(人も外せない)。選ばれたリポジトリだけ worktree を作る(設計メモ v0.14)
    if (task.repos.length > 1) design = { ...(design ?? task.design), architect: true };
    ensureWorktrees(ctx, task, task.repos);
  }
  applyEvent(ctx, taskId, { type: "approve", kind, ...(kind === "plan" && design ? { design } : {}) });
  if (kind === "final") {
    // 最終確認の承認は、承認した時点のコミットに紐づける
    for (const tr of listTaskRepos(ctx.db, taskId)) {
      addApproval(ctx.db, { taskId, repoId: tr.repoId, kind, result: "approved", commitSha: headSha(tr.worktreePath, ctx.gitEnv), comment });
    }
  } else {
    addApproval(ctx.db, { taskId, kind, result: "approved", comment });
  }
  if (comment) appendHumanNote(ctx, taskId, `${KIND_LABEL[kind]}の承認コメント`, comment);
}

const KIND_LABEL: Record<HumanApprovalKind, string> = { plan: "計画", design: "デザイン仕様", final: "最終確認", strategy: "戦略", scope: "要件", handoff: "引き渡し" };

export function rejectTask(ctx: AppContext, taskId: number, kind: HumanApprovalKind, comment: string): void {
  if (!comment.trim()) throw new Error("却下の理由(コメント)を書いてください");
  applyEvent(ctx, taskId, { type: "reject", kind });
  addApproval(ctx.db, { taskId, kind, result: "rejected", comment });
  appendHumanNote(ctx, taskId, `${KIND_LABEL[kind]}の却下`, comment);
}

export function answerTask(ctx: AppContext, taskId: number, message: string): void {
  if (!message.trim()) throw new Error("回答を書いてください");
  applyEvent(ctx, taskId, { type: "answer" });
  appendHumanNote(ctx, taskId, "人からの回答", message);
}

/**
 * デザインレビューで止まったときの人の判断(撮影できない、など)。回答してやり直すだけでは同じところで止まるため、
 * 飛ばして最終確認へ進めるか、実装者に差し戻す
 */
export function resolveDesignReview(ctx: AppContext, taskId: number, choice: "skip" | "implementer", comment?: string): void {
  if (choice === "implementer" && !comment?.trim()) throw new Error("差し戻す理由を書いてください");
  applyEvent(ctx, taskId, { type: choice === "skip" ? "skip_design_review" : "back_to_implementer" });
  if (comment?.trim()) appendHumanNote(ctx, taskId, choice === "skip" ? "デザインレビューを飛ばした理由" : "実装者への差し戻し(デザインレビューで止まったため)", comment);
}

export function cancelTask(ctx: AppContext, taskId: number): void {
  applyEvent(ctx, taskId, { type: "cancel" });
}
