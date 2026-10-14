import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { addEvent, createProject, createTask, getProject, getProjectByName, listEvents, listRepos, type Task } from "../db/store.ts";
import type { BounceInfo } from "./bounce.ts";
import type { AppContext } from "./context.ts";
import type { Handler, HandlerOutcome } from "./handlers.ts";
import { invokeRole, type InvokeResult } from "./invoke.ts";
import { humanNotesPath } from "./human.ts";
import { projectDir, taskDir } from "./paths.ts";
import { mustProject } from "./projects.ts";
import type { Role } from "./transitions.ts";

/**
 * 企画の流れ(設計メモ v0.19、フェーズ9)。調査 → 戦略 → 要件 → 構造・骨格 → 引き渡し。
 * 各段は、書く役のあとに批評担当(critic)が別のコンテキストで検証する。批評が approve なら次へ、changes_requested なら同じ段をやり直す。
 * 企画のタスクは worktree を作らない(作業場所は成果物ディレクトリ。リポジトリと手元の資料は読むだけ)
 */

export type StageKey = "research" | "strategy" | "scope" | "ux" | "handoff";
type Stage = { key: StageKey; writer: Role; label: string; files: string[] };

export const STAGES: Record<string, Stage> = {
  p_researching: { key: "research", writer: "researcher", label: "調査", files: ["research.md"] },
  p_strategizing: { key: "strategy", writer: "strategist", label: "戦略", files: ["strategy.md", "strategy.slides.md"] },
  p_scoping: { key: "scope", writer: "product", label: "要件", files: ["scope.md", "scope.slides.md"] },
  p_ux: { key: "ux", writer: "ux", label: "構造・骨格", files: ["structure.md", "skeleton.md"] },
  p_handing_off: { key: "handoff", writer: "handoff", label: "引き渡し", files: ["handoff.md"] },
};
const ORDER: StageKey[] = ["research", "strategy", "scope", "ux", "handoff"];

/** 企画用のプロジェクト(リポジトリなし。新サービスの企画に使う) */
export function createPlanningProject(ctx: AppContext, name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`プロジェクト名に使えるのは英数字と . _ - だけです: ${name}`);
  if (getProjectByName(ctx.db, name)) throw new Error(`プロジェクト ${name} はすでにあります`);
  createProject(ctx.db, { name });
}

/** 企画のタスクを作る。docs は読ませる手元の資料(ファイルかフォルダの絶対パス) */
export function createPlanningTask(ctx: AppContext, o: { projectName: string; title: string; body: string; docs: string[]; sourceUrl?: string }): Task {
  const project = mustProject(ctx.db, o.projectName);
  for (const d of o.docs) {
    if (!isAbsolute(d) || !existsSync(d)) throw new Error(`読ませる資料が見つかりません(絶対パスで指定してください): ${d}`);
  }
  const t = createTask(ctx.db, { projectId: project.id, title: o.title, body: o.body, kind: "planning", sourceKind: o.sourceUrl ? "paste" : "local", sourceUrl: o.sourceUrl });
  addEvent(ctx.db, { taskId: t.id, kind: "planning_inputs", payload: { docs: o.docs } });
  return t;
}

function planningInputs(ctx: AppContext, taskId: number): { docs: string[] } {
  return (listEvents(ctx.db, taskId, 2000).find((e) => e.kind === "planning_inputs")?.payload as { docs: string[] } | undefined) ?? { docs: [] };
}

const ROLE_TASK: Record<StageKey, string> = {
  research: "調べて `research.md` を書いてください(出典つき)",
  strategy: "`research.md` をもとに `strategy.md` と `strategy.slides.md` を書いてください",
  scope: "承認された `strategy.md` をもとに `scope.md` と `scope.slides.md` を書いてください",
  ux: "承認された `scope.md` をもとに `structure.md` と `skeleton.md` を書いてください",
  handoff: "`scope.md`・`structure.md`・`skeleton.md` をもとに、開発のチケットを `handoff.md` と構造化出力の `tickets` に書いてください",
};

/** 企画の役割への入力(題材、資料、リポジトリ、ここまでの成果物、批評、人のコメント) */
export function planningPrompt(ctx: AppContext, task: Task, stage: Stage, mode: "write" | "critique"): string {
  const dir = taskDir(ctx.home, task.id);
  const project = getProject(ctx.db, task.projectId)!;
  const repos = listRepos(ctx.db, task.projectId);
  const ref = (label: string, path: string) => (existsSync(path) ? [`- ${label}: ${path}`] : []);
  const upto = ORDER.slice(0, ORDER.indexOf(stage.key) + 1);
  const docs = Object.values(STAGES)
    .filter((s) => upto.includes(s.key))
    .flatMap((s) => s.files.filter((f) => !f.endsWith(".slides.md")).flatMap((f) => ref(`${s.label}(${f})`, join(dir, f))));
  const { docs: inputs } = planningInputs(ctx, task.id);
  return [
    `# 企画 #${task.id}: ${task.title}`,
    "",
    "## 題材(チケットの本文)",
    task.body.trim() || "(本文なし)",
    "",
    `- 成果物ディレクトリ(ここにだけ書ける): ${dir}`,
    ...(inputs.length ? ["- 読む資料(読むだけ):", ...inputs.map((d) => `  - ${d}`)] : []),
    ...(repos.length ? [`- 対象のプロジェクト ${project.name} のリポジトリ(読むだけ。既存サービスの新機能のとき、今の機能・画面・データを確かめる):`, ...repos.map((r) => `  - [${r.role}] ${r.path}`)] : ["- 新サービスの企画です(対象のリポジトリはまだありません)"]),
    ...ref("プロジェクトの設計判断ログ", join(projectDir(ctx.home, task.projectId), "decisions.md")),
    "",
    "## ここまでの成果物",
    ...(docs.length ? docs : ["- まだありません"]),
    ...ref("前回のこの段の批評(must を必ず解消する)", join(dir, `critique-${stage.key}.md`)),
    ...ref("人のコメント・回答(最優先で従う)", humanNotesPath(ctx.home, task.id)),
    "",
    "## 今回やること",
    mode === "write"
      ? `- ${ROLE_TASK[stage.key]}。前の版があれば、それを直す形で更新してください`
      : `- 「${stage.label}」の段の成果物(${stage.files.map((f) => join(dir, f)).join("、")})を批評し、成果物ディレクトリの \`critique.md\` に書いてください。成果物は変更しないでください`,
    "",
  ].join("\n");
}

const failed = (r: Extract<InvokeResult, { ok: false }>, role: string): HandlerOutcome => ({
  event: r.failure === "limit" ? { type: "limit_exceeded", reason: r.reason } : { type: "run_error", reason: r.reason },
  reason: `${role}: ${r.reason}`,
});

/** 企画の段: 書く役 → 批評担当 */
export const planningStage: Handler = async (ctx, task) => {
  const stage = STAGES[task.state];
  if (!stage) throw new Error(`企画の段ではありません: ${task.state}`);
  const dir = taskDir(ctx.home, task.id);
  mkdirSync(dir, { recursive: true });
  const w = await invokeRole(ctx, { roleName: stage.writer, taskId: task.id, cwd: dir, artifactsDir: dir, prompt: planningPrompt(ctx, task, stage, "write") });
  if (!w.ok) return failed(w, stage.writer);
  if (w.verdict === "need_human") return { event: { type: "verdict", role: stage.writer, verdict: "need_human" }, reason: `${stage.writer} が人の判断を求めています: ${w.summary}(詳細: ${dir})` };
  if (stage.key === "handoff") addEvent(ctx.db, { taskId: task.id, runId: w.runId, kind: "handoff", payload: { tickets: w.extra.tickets ?? [] } });

  const c = await invokeRole(ctx, { roleName: "critic", taskId: task.id, cwd: dir, artifactsDir: dir, prompt: planningPrompt(ctx, task, stage, "critique") });
  if (!c.ok) return failed(c, "critic");
  copyFileSync(join(dir, "critique.md"), join(dir, `critique-${stage.key}.md`));
  const issues = (c.extra.issues ?? []) as { severity: string; title: string; detail: string }[];
  addEvent(ctx.db, { taskId: task.id, runId: c.runId, kind: "critique", payload: { stage: stage.key, verdict: c.verdict, issues } });
  const detail = `(詳細: ${join(dir, `critique-${stage.key}.md`)})`;
  if (c.verdict === "approve") return { event: { type: "verdict", role: stage.writer, verdict: "ready" }, reason: `${stage.label}: 批評が承認しました — ${c.summary}${detail}` };
  if (c.verdict === "need_human") return { event: { type: "verdict", role: stage.writer, verdict: "need_human" }, reason: `批評担当が人の判断を求めています: ${c.summary}${detail}` };
  const musts = issues.filter((i) => i.severity === "must");
  const bounce: BounceInfo = {
    source: "critique",
    key: `${stage.key}:${musts.map((i) => i.title).sort().join("\n")}`,
    summary: `${stage.label}の批評の must: ${musts.map((i) => i.title).join(" / ").slice(0, 200)}`,
  };
  return { event: { type: "critique_bounce" }, reason: `${stage.label}: 批評が差し戻しました — ${c.summary}${detail}`, bounce };
};
