import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { addArtifact, addEvent, createProject, createTask, getProject, getProjectByName, getProjectSettings, listEvents, listRepos, type Task } from "../db/store.ts";
import type { BounceInfo } from "./bounce.ts";
import { rubricPath, type Rubric } from "../roles/rubrics.ts";
import { checkRubric, type RubricResult } from "./rubric-check.ts";
import type { Db } from "../db/connection.ts";
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
/** writerLabel は画面に出す担当名(内部の役割名 researcher などは出さない) */
export type Stage = { key: StageKey; writer: Role; writerLabel: string; label: string; files: string[] };

export const STAGES: Record<string, Stage> = {
  p_researching: { key: "research", writer: "researcher", writerLabel: "調査担当", label: "調査", files: ["research.md"] },
  p_strategizing: { key: "strategy", writer: "strategist", writerLabel: "企画担当", label: "戦略", files: ["strategy.md", "strategy.slides.md"] },
  p_scoping: { key: "scope", writer: "product", writerLabel: "要件担当", label: "要件", files: ["scope.md", "scope.slides.md"] },
  p_ux: { key: "ux", writer: "ux", writerLabel: "UX 担当", label: "構造・骨格", files: ["structure.md", "skeleton.md"] },
  p_handing_off: { key: "handoff", writer: "handoff", writerLabel: "まとめ担当", label: "引き渡し", files: ["handoff.md"] },
};
const ORDER: StageKey[] = ["research", "strategy", "scope", "ux", "handoff"];
/** 書いた後に人の承認がある段 */
const HUMAN_GATE: StageKey[] = ["strategy", "scope", "handoff"];

/** 承認のときに人が決めること(問いを1件ずつ。批評の must と should の件数つき) */
/** from は問いを出した担当(企画担当、要件担当、批評担当など) */
export type PlanningQuestions = { stage: StageKey; questions: { from: string; text: string }[]; musts: string[]; shoulds: number };

/**
 * 承認待ちの企画に、この段で出た問い(書く役か批評担当から)があれば返す。
 * その段を書き始めた後に出た問いだけ(却下して書き直した後は、前の問いを出さない)
 */
export function planningQuestions(db: Db, taskId: number): PlanningQuestions | null {
  const events = listEvents(db, taskId, 2000);
  // 段を書き始めた出来事: 固定の流れは段の状態に入ったとき、コーディネーターは書く役を動かす一手(フェーズ10)
  const started = (e: (typeof events)[number]) => {
    const p = e.payload as { to?: unknown; ok?: unknown; verdict?: unknown; role?: unknown };
    if (e.kind === "state_changed") return !!STAGES[String(p.to)];
    return e.kind === "coordinator_move" && p.ok === true && p.verdict === "run_role" && !!stageOfWriter(String(p.role));
  };
  const lastStart = events.filter(started).at(-1)?.id ?? 0;
  const q = events.filter((e) => e.kind === "planning_question" && e.id > lastStart).at(-1)?.payload as (Partial<PlanningQuestions> & { summary?: string }) | undefined;
  // 以前の形(問いを1つの文字列につないだもの)は、書く役と批評担当の部分に分けて読む
  if (q && !q.questions && q.summary) {
    const parts = q.summary.split(/。?(?=批評担当: |批評の must: )/);
    return {
      stage: q.stage!,
      questions: parts
        .filter((p) => !p.startsWith("批評の must: "))
        .map((p) => (p.startsWith("批評担当: ") ? { from: "批評担当", text: p.slice(6) } : { from: writerLabelOf(q.stage), text: p.replace(/^書く役: /, "") })),
      musts: parts.filter((p) => p.startsWith("批評の must: ")).flatMap((p) => p.slice(10).split(" / ")),
      shoulds: 0,
    };
  }
  if (!q?.questions?.length) return null;
  // 以前は書く役を「書く役」と記録していた。段の担当名に読み替える
  const questions = q.questions.map((x) => (x.from === "書く役" ? { ...x, from: writerLabelOf(q.stage) } : x));
  return { stage: q.stage!, questions, musts: q.musts ?? [], shoulds: q.shoulds ?? 0 };
}

/** 段のルーブリック(rubrics/planning-<段>.md。v0.22) */
const rubricName = (key: StageKey) => `planning-${key}`;
function stageRubric(ctx: AppContext, key: StageKey): Rubric {
  const r = ctx.rubrics.get(rubricName(key));
  if (!r) throw new Error(`ルーブリック ${rubricName(key)} がありません(rubrics/${rubricName(key)}.md)`);
  return r;
}

const writerLabelOf = (stage: StageKey | undefined) => Object.values(STAGES).find((s) => s.key === stage)?.writerLabel ?? "書く担当";

/** ダッシュボードや CLI に出す短い理由 */
export function criticQuestion(db: Db, taskId: number): string | null {
  const q = planningQuestions(db, taskId);
  return q ? `人の判断が要る点が ${q.questions.length} 件あります(承認のコメントで答えてください)` : null;
}

/** 役割が返した問い(questions)。分けて返さなかったら要約を1件の問いとして扱う */
const questionsOf = (r: { summary: string; extra: Record<string, unknown> }): string[] => {
  const list = ((r.extra.questions ?? []) as unknown[]).map(String).map((q) => q.trim()).filter(Boolean);
  return list.length ? list : [r.summary];
};

/** 企画用のプロジェクト(リポジトリなし。新サービスの企画に使う) */
export function createPlanningProject(ctx: AppContext, name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`プロジェクト名に使えるのは英数字と . _ - だけです: ${name}`);
  if (getProjectByName(ctx.db, name)) throw new Error(`プロジェクト ${name} はすでにあります`);
  createProject(ctx.db, { name });
}

/** 企画のタスクを作る。docs は読ませる手元の資料(ファイルかフォルダの絶対パス) */
/** flow を省くと、プロジェクトの設定(coordinator)に従う。既定は固定の流れ(フェーズ10) */
export function createPlanningTask(ctx: AppContext, o: { projectName: string; title: string; body: string; docs: string[]; sourceUrl?: string; flow?: Task["flow"] }): Task {
  const project = mustProject(ctx.db, o.projectName);
  for (const d of o.docs) {
    if (!isAbsolute(d) || !existsSync(d)) throw new Error(`読ませる資料が見つかりません(絶対パスで指定してください): ${d}`);
  }
  const flow = o.flow ?? (getProjectSettings(ctx.db, project.id).coordinator ? "coordinator" : "fixed");
  const t = createTask(ctx.db, { projectId: project.id, title: o.title, body: o.body, kind: "planning", sourceKind: o.sourceUrl ? "paste" : "local", sourceUrl: o.sourceUrl, flow });
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
export function planningPrompt(ctx: AppContext, task: Task, stage: Stage, mode: "write" | "critique", instruction?: string): string {
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
    ...rubricSection(stageRubric(ctx, stage.key), mode),
    ...(mode === "critique" && stage.key === "handoff" ? ticketsSection(ctx, task.id) : []),
    // ファイル名・書く場所・形式はこの入力の他の部分が正(10-3 で、指示に誤ったファイル名が混ざった)
    ...(instruction?.trim() ? ["## コーディネーターからの指示(ファイル名・書く場所・形式がこの入力の他の部分と食い違えば、他の部分に従う)", instruction.trim(), ""] : []),
    "## 今回やること",
    mode === "write"
      ? `- ${ROLE_TASK[stage.key]}。前の版があれば、それを直す形で更新してください`
      : `- 「${stage.label}」の段の成果物(${stage.files.map((f) => join(dir, f)).join("、")})を批評し、成果物ディレクトリの \`critique.md\` に書いてください。成果物は変更しないでください`,
    "",
  ].join("\n");
}

/**
 * 引き渡しの批評に渡すチケット。開発のタスクになるのは handoff.md ではなく構造化出力の tickets なので、批評はこれを見て判定する
 * (10-3: 受け入れ条件が handoff.md に無く、HO2・HO3 が毎回不合格になった)
 */
function ticketsSection(ctx: AppContext, taskId: number): string[] {
  const tickets = (listEvents(ctx.db, taskId, 2000).filter((e) => e.kind === "handoff").at(-1)?.payload as { tickets?: { title: string; body: string; acceptanceCriteria?: string[] }[] } | undefined)?.tickets ?? [];
  return [
    "## 引き渡すチケット(開発のタスクになるもの。まとめ担当の構造化出力のまま)",
    ...(tickets.length ? tickets.flatMap((t, i) => [`### ${i + 1}. ${t.title}`, t.body.trim(), "受け入れ条件:", ...(t.acceptanceCriteria ?? []).map((c) => `  - ${c}`), ""]) : ["(チケットがありません)", ""]),
  ];
}

/** 段のルーブリックの項目。批評担当はこのまま構造化出力の rubric で答え、書く役は満たすように書く */
function rubricSection(r: Rubric, mode: "write" | "critique"): string[] {
  const how =
    mode === "critique"
      ? "項目ごとに合否と根拠を、構造化出力の `rubric` で返してください(すべての項目に1回ずつ)。"
      : `批評担当はこの基準で判定します。must をすべて満たすと次へ進めます(${rubricPath(r.name)})。`;
  return [`## ルーブリック(${r.name}: ${r.description})`, how, ...r.items.map((i) => `- [${i.severity}] ${i.id}: ${i.text}`), ""];
}

const failed = (r: Extract<InvokeResult, { ok: false }>, role: string): HandlerOutcome => ({
  event: r.failure === "limit" ? { type: "limit_exceeded", reason: r.reason } : { type: "run_error", reason: r.reason },
  reason: `${role}: ${r.reason}`,
});

export type StageRunFailure = { ok: false; outcome: HandlerOutcome };
export type WriterRun = { ok: true; runId: number; verdict: string; summary: string };
export type CriticRun = { ok: true; runId: number; verdict: string; summary: string; detail: string; musts: string[]; shoulds: number; bounce?: BounceInfo };

/** 書く役が担当する段 */
export function stageOfWriter(role: string): Stage | undefined {
  return Object.values(STAGES).find((s) => s.writer === role);
}

/** 人に決めてほしいこと(need_human のとき)を段ごとに残す。承認を求めるときに添える */
function recordStageQuestions(ctx: AppContext, task: Task, stage: Stage, from: string, r: { runId: number; summary: string; extra: Record<string, unknown> }): void {
  addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "stage_questions", payload: { stage: stage.key, from, questions: questionsOf(r) } });
}

/** 企画の段の書く役を動かす。instruction はコーディネーターからの指示(フェーズ10) */
export async function runPlanningWriter(ctx: AppContext, task: Task, stage: Stage, instruction?: string): Promise<WriterRun | StageRunFailure> {
  const dir = taskDir(ctx.home, task.id);
  mkdirSync(dir, { recursive: true });
  const w = await invokeRole(ctx, { roleName: stage.writer, taskId: task.id, cwd: dir, artifactsDir: dir, prompt: planningPrompt(ctx, task, stage, "write", instruction) });
  if (!w.ok) return { ok: false, outcome: failed(w, stage.writer) };
  if (w.verdict === "need_human") recordStageQuestions(ctx, task, stage, stage.writerLabel, w);
  // 役割の出力以外の、この段のファイル(スライドの Markdown、structure.md など)も成果物として出す
  for (const f of stage.files) {
    const path = join(dir, f);
    if (f !== ctx.roles.get(stage.writer)?.output && existsSync(path)) addArtifact(ctx.db, { taskId: task.id, runId: w.runId, kind: f.replace(/\.md$/, ""), path });
  }
  if (stage.key === "handoff") addEvent(ctx.db, { taskId: task.id, runId: w.runId, kind: "handoff", payload: { tickets: w.extra.tickets ?? [] } });
  return { ok: true, runId: w.runId, verdict: w.verdict, summary: w.summary };
}

/** 企画の段の批評担当を動かし、ルーブリックで判定を検査する。差し戻しなら bounce を返す */
export async function runPlanningCritic(ctx: AppContext, task: Task, stage: Stage): Promise<CriticRun | StageRunFailure> {
  const dir = taskDir(ctx.home, task.id);
  const c = await invokeRole(ctx, { roleName: "critic", taskId: task.id, cwd: dir, artifactsDir: dir, prompt: planningPrompt(ctx, task, stage, "critique") });
  if (!c.ok) return { ok: false, outcome: failed(c, "critic") };
  copyFileSync(join(dir, "critique.md"), join(dir, `critique-${stage.key}.md`));
  addArtifact(ctx.db, { taskId: task.id, runId: c.runId, kind: `critique-${stage.key}`, path: join(dir, `critique-${stage.key}.md`), verdict: c.verdict });
  const issues = (c.extra.issues ?? []) as { severity: string; title: string; detail: string }[];
  addEvent(ctx.db, { taskId: task.id, runId: c.runId, kind: "critique", payload: { stage: stage.key, verdict: c.verdict, summary: c.summary, issues } });
  const detail = `(詳細: ${join(dir, `critique-${stage.key}.md`)})`;
  // 判定は項目ごとの結果と一致していなければならない(v0.22)。食い違えば推測で進めず人に回す
  const rubric = stageRubric(ctx, stage.key);
  const results = (c.extra.rubric ?? []) as RubricResult[];
  const rc = checkRubric(c.verdict, rubric, results);
  if (!rc.ok) return { ok: false, outcome: { event: { type: "run_error", reason: rc.reason }, reason: `critic: ${rc.reason}${detail}` } };
  const attempt = listEvents(ctx.db, task.id, 2000).filter((e) => e.kind === "rubric" && (e.payload as { stage?: unknown }).stage === stage.key).length + 1;
  addEvent(ctx.db, { taskId: task.id, runId: c.runId, kind: "rubric", payload: { stage: stage.key, rubric: rubric.name, verdict: c.verdict, results, mustFailed: rc.mustFailed, shouldFailed: rc.shouldFailed, attempt } });
  if (c.verdict === "need_human") recordStageQuestions(ctx, task, stage, "批評担当", c);
  const itemText = (id: string) => `${id}: ${rubric.items.find((i) => i.id === id)!.text}`;
  const musts = [...rc.mustFailed.map(itemText), ...issues.filter((i) => i.severity === "must").map((i) => i.title)];
  const bounce: BounceInfo | undefined =
    c.verdict === "changes_requested"
      ? { source: "critique", key: `${stage.key}:${[...rc.mustFailed].sort().join(",")}`, summary: `${stage.label}の批評の must: ${rc.mustFailed.map(itemText).join(" / ").slice(0, 200)}` }
      : undefined;
  return { ok: true, runId: c.runId, verdict: c.verdict, summary: c.summary, detail, musts, shoulds: issues.filter((i) => i.severity === "should").length, bounce };
}

/**
 * 承認待ちに添える問い(planning_question)を、この段で出た問い(書く役か批評担当から)から作る。
 * since より後(その段を最後に書き始めた後)の問いだけを使う。問いが無ければ何もしない
 */
export function recordPlanningQuestions(ctx: AppContext, task: Task, stage: Stage, o: { since: number; runId: number; musts: string[]; shoulds: number }): PlanningQuestions | null {
  const asked = listEvents(ctx.db, task.id, 2000).filter((e) => e.kind === "stage_questions" && (e.runId ?? 0) >= o.since && (e.payload as { stage?: unknown }).stage === stage.key);
  const questions = asked.flatMap((e) => {
    const p = e.payload as { from: string; questions: string[] };
    return p.questions.map((text) => ({ from: p.from, text }));
  });
  if (!questions.length) return null;
  const q: PlanningQuestions = { stage: stage.key, questions, musts: o.musts, shoulds: o.shoulds };
  addEvent(ctx.db, { taskId: task.id, runId: o.runId, kind: "planning_question", payload: q });
  return q;
}

/** 企画の段(固定の流れ): 書く役 → 批評担当 */
export const planningStage: Handler = async (ctx, task) => {
  const stage = STAGES[task.state];
  if (!stage) throw new Error(`企画の段ではありません: ${task.state}`);
  const dir = taskDir(ctx.home, task.id);
  const w = await runPlanningWriter(ctx, task, stage);
  if (!w.ok) return w.outcome;
  const gated = HUMAN_GATE.includes(stage.key);
  // 人の承認が無い段で書く役が止まったら、人の回答待ち
  if (w.verdict === "need_human" && !gated) return { event: { type: "verdict", role: stage.writer, verdict: "need_human" }, reason: `${stage.writerLabel}が人の判断を求めています: ${w.summary}(詳細: ${dir})` };
  const c = await runPlanningCritic(ctx, task, stage);
  if (!c.ok) return c.outcome;

  // 次に人の承認がある段で、書く役か批評担当が人の判断を求めたら、自動では差し戻さずに承認待ちへ進む。
  // 問いと批評の must を承認の理由に添え、人が承認のコメントで答えるか、却下して書き直させる(承認と回答を二度させない。実機の通し確認で発見)
  if (gated && (w.verdict === "need_human" || c.verdict === "need_human")) {
    const q = recordPlanningQuestions(ctx, task, stage, { since: w.runId, runId: c.runId, musts: c.musts, shoulds: c.shoulds });
    return { event: { type: "verdict", role: stage.writer, verdict: "ready" }, reason: `${stage.label}: 人の判断が要る点が ${q?.questions.length ?? 0} 件あります${c.detail}` };
  }
  if (c.verdict === "approve") return { event: { type: "verdict", role: stage.writer, verdict: "ready" }, reason: `${stage.label}: 批評が承認しました — ${c.summary}${c.detail}` };
  if (c.verdict === "need_human") return { event: { type: "verdict", role: stage.writer, verdict: "need_human" }, reason: `批評担当が人の判断を求めています: ${c.summary}${c.detail}` };
  return { event: { type: "critique_bounce" }, reason: `${stage.label}: 批評が差し戻しました — ${c.summary}${c.detail}`, bounce: c.bounce };
};
