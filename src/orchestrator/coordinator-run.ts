import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { addArtifact, addEvent, invalidateApprovals, listEvents, listRuns, listValidApprovals, type ApprovalKind, type Task } from "../db/store.ts";
import type { AppContext } from "./context.ts";
import { afterRejection, limitReason, ROLES_BY_KIND, validateMove, type CoordinatorFacts, type CoordinatorMove } from "./coordinator.ts";
import type { Handler, HandlerOutcome } from "./handlers.ts";
import { humanNotesPath } from "./human.ts";
import { invokeRole, type InvokeResult } from "./invoke.ts";
import { projectDir, taskDir } from "./paths.ts";
import { recordPlanningQuestions, runPlanningCritic, runPlanningWriter, STAGES, stageOfWriter, type Stage, type StageKey } from "./planning.ts";
import type { HumanApprovalKind } from "./transitions.ts";

/**
 * コーディネーターで進める(設計メモ v0.21・v0.22、フェーズ10-2)。状態 coordinating の1手:
 * コーディネーターを起動 → 一手を検証(coordinator.ts)→ 許されれば実行し、結果を出来事で返す。
 * 却下されたら理由を添えてもう一度聞き、続けて却下されたら人に回す。一手は出来事 coordinator_move と coordinator-log.md に残す(記録はコードが受け持つ)。
 * 10-2 では企画の流れだけ。開発の流れは 10-4
 */

const HUMAN_GATES: HumanApprovalKind[] = ["plan", "design", "final", "strategy", "scope", "handoff"];
const ORDER: StageKey[] = ["research", "strategy", "scope", "ux", "handoff"];
/** 段を書き直したら、その段と後ろの段の承認は成り立たない */
const GATE_OF_STAGE: Partial<Record<StageKey, HumanApprovalKind>> = { strategy: "strategy", scope: "scope", handoff: "handoff" };
const STAGE_OF_GATE: Partial<Record<HumanApprovalKind, StageKey>> = { strategy: "strategy", scope: "scope", handoff: "handoff" };
const stageByKey = (key: StageKey): Stage => Object.values(STAGES).find((s) => s.key === key)!;

/** このタスクの最後の書く役の実行(stage を指定すればその段の) */
function lastWriterRun(ctx: AppContext, taskId: number, stage?: Stage): { id: number; stage: Stage } | undefined {
  for (const r of listRuns(ctx.db, { taskId }).reverse()) {
    const s = stageOfWriter(r.role);
    if (s && (!stage || s.key === stage.key)) return { id: r.id, stage: s };
  }
  return undefined;
}

/** 検証に使う事実を DB から集める */
export function gatherFacts(ctx: AppContext, task: Task): CoordinatorFacts {
  // 失効していない承認のうち、種類ごとに最後のものが approved なもの
  const latest = new Map<ApprovalKind, string>();
  for (const a of listValidApprovals(ctx.db, task.id)) latest.set(a.kind, a.result);
  const approvals = HUMAN_GATES.filter((k) => latest.get(k) === "approved");
  const runs = listRuns(ctx.db, { taskId: task.id });
  const rubrics = listEvents(ctx.db, task.id, 2000).filter((e) => e.kind === "rubric");
  // 最新の成果物(最後の書く役の実行)より後の、最新の批評で must がすべて合格した段
  const rubricPassed = ORDER.filter((key) => {
    const w = lastWriterRun(ctx, task.id, stageByKey(key));
    const r = rubrics.filter((e) => (e.payload as { stage?: unknown }).stage === key).at(-1);
    return !!w && !!r && (r.runId ?? 0) > w.id && ((r.payload as { mustFailed?: unknown[] }).mustFailed ?? []).length === 0;
  });
  return {
    kind: task.kind,
    approvals,
    // 開発の流れ(テストの再実行、統合)は 10-4 で集める
    testsPassed: false,
    integrated: false,
    runCount: runs.length,
    costUsd: runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
    rubricPassed,
  };
}

const DEFAULT_PLANNING_FLOW = [
  "1. researcher が調べる → critic が批評する",
  "2. strategist が戦略を書く → critic → 戦略の承認(gate: strategy)",
  "3. product が要件を書く → critic → 要件の承認(gate: scope)",
  "4. ux が構造・骨格を書く → critic",
  "5. handoff が開発のチケットにまとめる → critic → 引き渡しの承認(gate: handoff)。承認されると開発のタスクができ、この企画はその完了を待つ",
  "- critic は、最後に書いた段の成果物を、その段のルーブリックで批評します",
  "- 批評が changes_requested なら、同じ段の書く役に、批評(critique-<段>.md)の must を直すよう指示して書き直させる",
  "- 書く役か批評が need_human を返したとき: 承認がある段(戦略・要件・引き渡し)なら、そのまま承認を求めてよい(問いは承認に添えられ、人が承認のコメントで答える)。承認の無い段(調査、構造・骨格)なら ask_human",
  "- 批評の should は記録だけ。人のコメントで求められたときを除き、同じ段でも後の段でも、書く役に直させない(後の段に持ち込ませない)",
  "- 書く役への指示(input)は、その段で特に見てほしいこと・直してほしいことだけを1〜3文で。ファイル名・書く場所・形式・frontmatter は書かない(ツールが渡す)。機能やチケットを足すよう指示しない",
  "- critic には指示が渡らない(批評はルーブリックで独立に行う)。critic の input は「批評」の一言でよい",
];

function coordinatorPrompt(ctx: AppContext, task: Task, f: CoordinatorFacts, rejection?: string): string {
  const dir = taskDir(ctx.home, task.id);
  const ref = (label: string, path: string) => (existsSync(path) ? [`- ${label}: ${path}`] : []);
  const runs = listRuns(ctx.db, { taskId: task.id }).slice(-20);
  const files = existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".md")).sort() : [];
  const { maxRunsPerTask, maxCostPerTaskUsd, maxReviewRounds } = ctx.config.limits;
  return [
    `# 企画 #${task.id}: ${task.title}(次の一手を決める)`,
    "",
    "## 題材(チケットの本文)",
    task.body.trim() || "(本文なし)",
    "",
    "## 今の状況",
    `- タスクの種類: ${task.kind}`,
    `- 人の承認(失効していないもの): ${f.approvals.join(", ") || "なし"}`,
    `- ルーブリックの must がすべて合格した段: ${f.rubricPassed.join(", ") || "なし"}`,
    `- 役割の起動: ${f.runCount} 回(上限 ${maxRunsPerTask} 回)、費用 $${f.costUsd.toFixed(2)}(上限 $${maxCostPerTaskUsd})`,
    `- 批評の差し戻し: ${task.reviewRounds} 回(人の承認・回答の後から数える。上限 ${maxReviewRounds} 回)`,
    "",
    "## これまでの実行(新しい20件)",
    ...(runs.length ? runs.map((r) => `- #${r.id} ${r.role}: ${r.verdict ?? r.state} — ${(r.summary ?? r.error ?? "").replace(/\s+/g, " ").slice(0, 200)}`) : ["- まだありません"]),
    "",
    "## 読むもの(読むだけ)",
    `- 成果物ディレクトリ: ${dir}(${files.join("、") || "まだ空"})`,
    ...ref("人のコメント・回答(最優先で従う)", humanNotesPath(ctx.home, task.id)),
    ...ref("プロジェクトの設計判断ログ", join(projectDir(ctx.home, task.projectId), "decisions.md")),
    ...ref("これまでの一手の記録", join(dir, "coordinator-log.md")),
    "",
    "## 使える役割",
    ...ROLES_BY_KIND[task.kind].map((name) => `- ${name}: ${ctx.roles.get(name)?.description ?? ""}`),
    "",
    "## 既定の進め方",
    ...DEFAULT_PLANNING_FLOW,
    "",
    ...(rejection ? ["## 前回の一手は却下されました", rejection, "理由を読んで、別の一手を返してください。", ""] : []),
    "## 今回やること",
    "- 次の一手を1つ、構造化出力で返してください(`verdict` が一手の種類)",
    "",
  ].join("\n");
}

/** 一手を出来事と coordinator-log.md に残す */
function logMove(ctx: AppContext, task: Task, runId: number, raw: { verdict: string; summary: string; extra: Record<string, unknown> }, outcome: { ok: true } | { ok: false; rejection: string; limit?: boolean }): void {
  const x = raw.extra as { role?: string | null; input?: string | null; question?: string | null; gate?: string | null; reason?: string; deviatesFromDefault?: boolean };
  addEvent(ctx.db, {
    taskId: task.id,
    runId,
    kind: "coordinator_move",
    payload: { ok: outcome.ok, verdict: raw.verdict, summary: raw.summary, role: x.role ?? null, input: x.input ?? null, question: x.question ?? null, gate: x.gate ?? null, reason: x.reason ?? "", deviatesFromDefault: !!x.deviatesFromDefault, ...(outcome.ok ? {} : { rejection: outcome.rejection, limit: !!outcome.limit }) },
  });
  const dir = taskDir(ctx.home, task.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "coordinator-log.md");
  const first = !existsSync(path);
  const target = x.role ?? x.gate ?? "";
  appendFileSync(
    path,
    [
      ...(first ? ["# コーディネーターの一手の記録", ""] : []),
      `## ${new Date().toISOString()} ${raw.verdict}${target ? ` ${target}` : ""}${outcome.ok ? "" : "(却下)"}`,
      `- 理由: ${x.reason ?? ""}`,
      `- 既定の進め方から外れる: ${x.deviatesFromDefault ? "はい" : "いいえ"}`,
      ...(x.input ? [`- 指示: ${x.input}`] : []),
      ...(x.question ? [`- 問い: ${x.question}`] : []),
      ...(outcome.ok ? [] : [`- 却下の理由: ${outcome.rejection}`]),
      "",
    ].join("\n") + "\n",
  );
  if (first) addArtifact(ctx.db, { taskId: task.id, runId, kind: "coordinator-log", path });
}

const failedRun = (r: Extract<InvokeResult, { ok: false }>): HandlerOutcome => ({
  event: r.failure === "limit" ? { type: "limit_exceeded", reason: r.reason } : { type: "run_error", reason: r.reason },
  reason: `coordinator: ${r.reason}`,
});

/** 許された一手を実行する。実行の前に分かる不都合(書いていない段の批評など)は、却下として返す */
async function execute(ctx: AppContext, task: Task, move: CoordinatorMove, runId: number): Promise<HandlerOutcome | { rejection: string }> {
  switch (move.type) {
    case "run_role": {
      const writerStage = stageOfWriter(move.role);
      if (writerStage) {
        // 書き直す段と、その後ろの段の承認は成り立たない(守り。承認された戦略の上に要件がある、など)
        const gates = ORDER.slice(ORDER.indexOf(writerStage.key)).flatMap((k) => GATE_OF_STAGE[k] ?? []);
        invalidateApprovals(ctx.db, task.id, gates);
        const w = await runPlanningWriter(ctx, task, writerStage, move.input);
        return w.ok ? { event: { type: "coordinated" } } : w.outcome;
      }
      if (move.role === "critic") {
        const last = lastWriterRun(ctx, task.id);
        if (!last) return { rejection: "批評する段がありません(まだどの段も書かれていません)。先に書く役を動かしてください" };
        const c = await runPlanningCritic(ctx, task, last.stage);
        if (!c.ok) return c.outcome;
        return { event: { type: "coordinated", bounced: !!c.bounce }, bounce: c.bounce, ...(c.bounce ? { reason: `${last.stage.label}: 批評が差し戻しました — ${c.summary}${c.detail}` } : {}) };
      }
      throw new Error(`役割 ${move.role} はまだコーディネーターで動かせません(開発の流れは 10-4)`);
    }
    case "ask_human":
      return { event: { type: "ask_human", question: move.question }, reason: `コーディネーターの問い: ${move.question}` };
    case "request_approval": {
      const key = STAGE_OF_GATE[move.gate];
      if (key) {
        const stage = stageByKey(key);
        const since = lastWriterRun(ctx, task.id, stage)?.id ?? 0;
        const critique = listEvents(ctx.db, task.id, 2000).filter((e) => e.kind === "critique" && (e.payload as { stage?: unknown }).stage === key).at(-1);
        const issues = ((critique?.payload as { issues?: { severity: string; title: string }[] } | undefined)?.issues ?? []);
        recordPlanningQuestions(ctx, task, stage, { since, runId, musts: issues.filter((i) => i.severity === "must").map((i) => i.title), shoulds: issues.filter((i) => i.severity === "should").length });
      }
      return { event: { type: "gate_requested", kind: move.gate }, reason: `コーディネーターが承認(${move.gate})を求めています: ${move.reason}` };
    }
    case "complete":
      return { event: { type: "complete" } };
    case "fail":
      return { event: { type: "fail", reason: move.reason }, reason: `コーディネーターが失敗にしました: ${move.reason}` };
  }
}

export const coordinatorStep: Handler = async (ctx, task) => {
  if (task.kind !== "planning") throw new Error("コーディネーターで進められるのは、まだ企画のタスクだけです(開発の流れは 10-4)");
  const limits = { maxRunsPerTask: ctx.config.limits.maxRunsPerTask, maxCostPerTaskUsd: ctx.config.limits.maxCostPerTaskUsd };
  const dir = taskDir(ctx.home, task.id);
  mkdirSync(dir, { recursive: true });
  // 上限に達していたら、コーディネーターも起動しない
  const before = limitReason(gatherFacts(ctx, task), limits);
  if (before) return { event: { type: "limit_exceeded", reason: before }, reason: before };
  let rejection: string | undefined;
  for (let consecutive = 1; ; consecutive++) {
    const r = await invokeRole(ctx, { roleName: "coordinator", taskId: task.id, cwd: dir, artifactsDir: dir, prompt: coordinatorPrompt(ctx, task, gatherFacts(ctx, task), rejection) });
    if (!r.ok) return failedRun(r);
    const check = validateMove({ verdict: r.verdict, summary: r.summary, ...r.extra }, gatherFacts(ctx, task), ctx.roles, limits);
    let why: string;
    if (check.ok) {
      const done = await execute(ctx, task, check.move, r.runId);
      if (!("rejection" in done)) {
        logMove(ctx, task, r.runId, r, { ok: true });
        return done;
      }
      why = done.rejection;
    } else {
      if (check.kind === "limit") {
        logMove(ctx, task, r.runId, r, { ok: false, rejection: check.reason, limit: true });
        return { event: { type: "limit_exceeded", reason: check.reason }, reason: check.reason };
      }
      why = check.reason;
    }
    logMove(ctx, task, r.runId, r, { ok: false, rejection: why });
    if (afterRejection(consecutive) === "needs_input") {
      const reason = `コーディネーターの一手が ${consecutive} 回続けて却下されました。人の判断が必要です(最後の理由: ${why})`;
      return { event: { type: "run_error", reason }, reason };
    }
    rejection = why;
  }
};
