import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addApproval, addEvent, listEvents, listRepos, setTaskDesign, setTaskRepos, getRepo, getRepoProfile, listTaskRepos, listValidApprovals, setProjectProfile, setRepoProfile, type Task } from "../db/store.ts";
import type { Judgment, Profile } from "../roles/schemas.ts";
import { changedFiles, commitsSince, containsRef, diffFromBase, diffStat, hasTrackedChanges, headSha, isDirty, mergeBase } from "../git/worktree.ts";
import { detectTestChanges, renderTestChanges } from "./test-changes.ts";
import { testCommandFor, verifyTests } from "./verify.ts";
import type { AppContext } from "./context.ts";
import { invokeRole, type InvokeResult } from "./invoke.ts";
import { projectDir, taskDir } from "./paths.ts";
import type { ScreenRequest } from "./context.ts";
import { captureTaskScreens } from "./screens.ts";
import type { Shot } from "../browser/chrome.ts";
import { applyAudit, checkReviewConsistency, mustIndexes, type Finding } from "./review-findings.ts";
import { taskPrompt } from "./prompts.ts";
import type { Role, TaskEvent } from "./transitions.ts";

export type HandlerOutcome = { event: TaskEvent; reason?: string };
export type Handler = (ctx: AppContext, task: Task) => Promise<HandlerOutcome>;

/** 役割の実行結果を、状態遷移の出来事にする */
export function outcomeOf(r: InvokeResult, role: Role, artifactPath?: string): HandlerOutcome {
  if (!r.ok) return { event: r.failure === "limit" ? { type: "limit_exceeded", reason: r.reason } : { type: "run_error", reason: r.reason }, reason: `${role}: ${r.reason}` };
  return {
    event: { type: "verdict", role, verdict: r.verdict },
    reason: `${role} の判定: ${r.verdict} — ${r.summary}${artifactPath ? `(詳細: ${artifactPath})` : ""}`,
  };
}

/** フェーズ1は1リポジトリ。複数リポジトリ対応(フェーズ5)では役目ごとに実装者を順に動かす */
export function primaryRepo(ctx: AppContext, task: Task) {
  const tr = listTaskRepos(ctx.db, task.id)[0];
  if (!tr) throw new Error(`タスク ${task.id} の worktree がありません`);
  return tr;
}

const planner: Handler = async (ctx, task) => {
  const dir = taskDir(ctx.home, task.id);
  mkdirSync(dir, { recursive: true });
  const repos = listRepos(ctx.db, task.projectId);
  const multi = repos.length > 1;
  // 複数リポジトリでは worktree がまだ無い(計画で決める)。作業場所は成果物ディレクトリで、各リポジトリの本体を読む
  const cwd = multi ? dir : primaryRepo(ctx, task).worktreePath;
  const r = await invokeRole(ctx, { roleName: "planner", taskId: task.id, cwd, artifactsDir: dir, prompt: taskPrompt(ctx, task, "planner") });
  if (r.ok) {
    addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "plan", payload: r.extra });
    const d = r.extra.design as { architect: boolean; designer: boolean };
    let architect = d.architect;
    if (multi && r.verdict === "ready") {
      const chosen = (r.extra.repos as string[] | undefined) ?? [];
      const unknown = chosen.filter((role) => !repos.some((x) => x.role === role));
      if (chosen.length === 0) return stop(`planner: 変更するリポジトリ(repos)を返しませんでした(詳細: ${dir}/plan.md)`);
      if (unknown.length > 0) return stop(`planner: 無い役目のリポジトリを返しました: ${unknown.join(", ")}(役目: ${repos.map((x) => x.role).join(", ")})`);
      setTaskRepos(ctx.db, task.id, [...new Set(chosen)]);
      // 2つ以上のリポジトリを変えるなら、設計者は必須(インターフェース契約を書く。設計メモ 5.3)
      if (new Set(chosen).size > 1) architect = true;
    }
    setTaskDesign(ctx.db, task.id, { architect, designer: d.designer });
  }
  return outcomeOf(r, "planner", `${dir}/plan.md`);
};

/** 設計者・デザイナーが返した判断を、プロジェクトの設計判断ログに追記する(エージェントはプロジェクトの領域に書かない) */
function appendDecisions(ctx: AppContext, task: Task, role: "architect" | "designer", decisions: string[], runId: number): void {
  const items = decisions.map((d) => d.trim()).filter(Boolean);
  if (items.length === 0) return;
  const dir = projectDir(ctx.home, task.projectId);
  mkdirSync(dir, { recursive: true });
  // 人が読むログなので、この PC の日付で書く(UTC だと日本の朝は前日になる)
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  appendFileSync(join(dir, "decisions.md"), `\n## ${day} #${task.id} ${task.title}(${role === "architect" ? "設計者" : "デザイナー"})\n\n${items.map((d) => `- ${d}`).join("\n")}\n`);
  addEvent(ctx.db, { taskId: task.id, runId, kind: "decisions", payload: { role, decisions: items } });
}

/**
 * 設計の段(designing、設計メモ v0.12)。タスクの design に従い、設計者 → デザイナーの順に必要なものだけ動かす。
 * デザイナーは設計者の design.md を読む。どちらかが need_human などを返したら、そこで止める
 */
const design: Handler = async (ctx, task) => {
  const tr = primaryRepo(ctx, task);
  const dir = taskDir(ctx.home, task.id);
  const run = (role: "architect" | "designer") =>
    invokeRole(ctx, { roleName: role, taskId: task.id, cwd: tr.worktreePath, artifactsDir: dir, prompt: taskPrompt(ctx, task, role) });

  if (task.design.architect) {
    const r = await run("architect");
    if (r.ok && r.verdict === "ready") appendDecisions(ctx, task, "architect", r.extra.decisions as string[], r.runId);
    if (!r.ok || r.verdict !== "ready" || !task.design.designer) return outcomeOf(r, "architect", `${dir}/design.md`);
  }
  if (task.design.designer) {
    const r = await run("designer");
    if (r.ok && r.verdict === "ready") appendDecisions(ctx, task, "designer", r.extra.decisions as string[], r.runId);
    return outcomeOf(r, "designer", `${dir}/ui-spec.md`);
  }
  // 人が両方とも外した後に戻ってきた場合など。設計の段は飛ばして実装へ
  return { event: { type: "verdict", role: "architect", verdict: "ready" }, reason: "設計の段で動かす役割がないため、実装に進みます" };
};

/** エージェントのコミットを人のコミットと区別するための作者と目印(trailer はフックが付ける) */
export function agentGitEnv(role: string): Record<string, string> {
  const name = `agent-crew ${role}`;
  const email = "agent-crew@localhost";
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, AGENT_CREW_ROLE: role };
}

const implementer: Handler = async (ctx, task) => {
  const tr = primaryRepo(ctx, task);
  const dir = taskDir(ctx.home, task.id);
  const before = headSha(tr.worktreePath, ctx.gitEnv);
  const r = await invokeRole(ctx, {
    roleName: "implementer",
    taskId: task.id,
    cwd: tr.worktreePath,
    artifactsDir: dir,
    prompt: taskPrompt(ctx, task, "implementer"),
    extraEnv: agentGitEnv("implementer"),
  });
  if (r.ok && r.verdict === "done") {
    // 実装者の申告ではなく、worktree の実際の状態で確かめる
    if (isDirty(tr.worktreePath, ctx.gitEnv)) {
      return { event: { type: "run_error", reason: "未コミットの変更が残っています" }, reason: `implementer: 未コミットの変更が残っています(${tr.worktreePath})` };
    }
    const commits = commitsSince(tr.worktreePath, before, ctx.gitEnv);
    if (commits.length === 0) {
      // 差し戻し・回答での再開の後で、ブランチに実装のコミットがすでにあれば、原因が環境(依存の壊れなど)でコードを直す必要が無いこともある。
      // 警告を残してテストの再実行・レビューに進める(虚偽の done は、そこでもう一度捕まる)。最初の実装でコミットが無いのは止める。
      // 差し戻しの回数は回答で0に戻るので、条件にしない(4b で判明)
      const already = commitsSince(tr.worktreePath, tr.baseSha, ctx.gitEnv).length > 0;
      if (!already) return { event: { type: "run_error", reason: "コミットがありません" }, reason: "implementer: done と判定しましたが、コミットがありません" };
      addEvent(ctx.db, {
        taskId: task.id,
        runId: r.runId,
        kind: "warning",
        payload: { message: `実装者が新しいコミットなしで done を返しました(理由: ${r.summary})。テストの再実行とレビューで確かめます` },
      });
    } else {
      addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "implemented", payload: { commits: commits.map((c) => ({ sha: c.sha, subject: c.subject })) } });
    }
    const testCommand = r.extra.testCommand;
    if (typeof testCommand === "string" && testCommand.trim()) {
      addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "test_command", payload: { command: testCommand.trim() } });
    }
  }
  return outcomeOf(r, "implementer", `${dir}/impl-notes.md`);
};

/** 監査担当に渡す、Must 指摘の一覧(番号は findings 全体の中での位置) */
function mustList(findings: Finding[]): string[] {
  return mustIndexes(findings).flatMap((i) => {
    const f = findings[i]!;
    return [`- [${i}] ${f.title}(${f.file}${f.line ? `:${f.line}` : ""})`, `  - 問題: ${f.detail}`, `  - 直し方(レビュワー案): ${f.suggestion}`];
  });
}

/**
 * レビュワーの内部で、Must 指摘を別のエージェント(auditor)に事実確認させる。却下できるのは、
 * auditor が overturned を返し、かつ判定がすべての Must を invalid としているときだけ(それ以外は reviewer の判定のまま)。
 * 監査が動かなかったとき(失敗)は、reviewer の判定を変えずに警告を残す。
 */
async function auditMusts(
  ctx: AppContext,
  task: Task,
  o: { cwd: string; dir: string; findings: Finding[]; reviewRunId: number },
): Promise<"upheld" | "overturned" | "need_human" | "skipped"> {
  const warn = (message: string) => addEvent(ctx.db, { taskId: task.id, kind: "warning", payload: { message } });
  const r = await invokeRole(ctx, {
    roleName: "auditor",
    taskId: task.id,
    cwd: o.cwd,
    artifactsDir: o.dir,
    prompt: taskPrompt(ctx, task, "auditor", [
      `- 差分: ${join(o.dir, "diff.patch")}`,
      `- レビュー結果(全指摘): ${join(o.dir, "review.md")}`,
      "- 監査する Must 指摘(番号は `judgments` の `finding` にそのまま使う):",
      ...mustList(o.findings),
    ]),
  });
  if (!r.ok) {
    warn(`Must 指摘の監査が動きませんでした。レビュワーの判定のまま進めます: ${r.reason}`);
    return "skipped";
  }
  const judgments = (r.extra.judgments ?? []) as Judgment[];
  const { standing, dismissed } = applyAudit(o.findings, judgments);
  addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "audit", payload: { reviewRunId: o.reviewRunId, verdict: r.verdict, standing, dismissed, judgments } });
  if (r.verdict === "need_human") return "need_human";
  if (r.verdict === "overturned" && standing.length === 0) return "overturned";
  if (r.verdict === "overturned") warn(`auditor は overturned を返しましたが、Must ${standing.map((i) => `[${i}]`).join("")} は却下されていません(判定が足りない)。差し戻します`);
  return "upheld";
}

/**
 * レビュワー: テストを再実行してから、差分・テストの変更の検出結果・人の変更を材料にレビューさせる。
 * 判定と指摘の重大度が食い違えば人に確認する。changes_requested のときは、Must 指摘を auditor に事実確認させる。
 */
const reviewer: Handler = async (ctx, task) => {
  const v = await verifyTests(ctx, task);
  if (v.status === "error") return { event: { type: "run_error", reason: v.reason }, reason: `verifier: ${v.reason}` };
  if (v.status === "failed") return { event: { type: "tests_failed" }, reason: `テストの再実行が失敗しました(詳細: ${v.reportPath})` };

  const tr = primaryRepo(ctx, task);
  const repo = getRepo(ctx.db, tr.repoId)!;
  const dir = taskDir(ctx.home, task.id);
  // 前の周回の監査結果は、今回のレビューには当てはまらない。残すと実装者が古い「対応不要」を読んでしまう
  rmSync(join(dir, "audit.md"), { force: true });
  const base = mergeBase(tr.worktreePath, repo.defaultBranch, ctx.gitEnv);
  const diff = diffFromBase(tr.worktreePath, base, ctx.gitEnv);
  writeFileSync(join(dir, "diff.patch"), diff);
  writeFileSync(join(dir, "test-changes.md"), renderTestChanges(detectTestChanges({ nameStatus: changedFiles(tr.worktreePath, base, ctx.gitEnv), diff })));
  const human = commitsSince(tr.worktreePath, base, ctx.gitEnv).filter((c) => !c.agentRole);
  const head = headSha(tr.worktreePath, ctx.gitEnv);

  const r = await invokeRole(ctx, {
    roleName: "reviewer",
    taskId: task.id,
    cwd: tr.worktreePath,
    artifactsDir: dir,
    prompt: taskPrompt(ctx, task, "reviewer", [
      `- 差分(ベース ${base.slice(0, 12)} から HEAD ${head.slice(0, 12)}): ${join(dir, "diff.patch")}`,
      `- テストの変更の検出結果(必ず確認する): ${join(dir, "test-changes.md")}`,
      `- テストの再実行: ${v.status === "passed" ? `成功(${v.command})` : "テストコマンドが無いため未確認"}`,
      ...(human.length
        ? ["- 人の変更が含まれます(同じ基準でレビューする):", ...human.map((c) => `  - ${c.sha.slice(0, 12)} ${c.subject}(${c.author})`)]
        : []),
    ]),
  });
  if (!r.ok) return outcomeOf(r, "reviewer", `${dir}/review.md`);

  const findings = r.extra.findings as Finding[];
  addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "review_findings", payload: { verdict: r.verdict, findings } });
  const inconsistent = checkReviewConsistency(r.verdict, findings);
  if (inconsistent) return { event: { type: "run_error", reason: inconsistent }, reason: `reviewer: ${inconsistent}(詳細: ${dir}/review.md)` };

  const approve = () => addApproval(ctx.db, { taskId: task.id, repoId: tr.repoId, kind: "review", result: "approved", commitSha: head });
  if (r.verdict === "approve") {
    approve();
    return outcomeOf(r, "reviewer", `${dir}/review.md`);
  }
  if (r.verdict !== "changes_requested" || !ctx.config.review.audit) return outcomeOf(r, "reviewer", `${dir}/review.md`);

  const audited = await auditMusts(ctx, task, { cwd: tr.worktreePath, dir, findings, reviewRunId: r.runId });
  if (audited === "overturned") {
    approve();
    return {
      event: { type: "verdict", role: "reviewer", verdict: "approve" },
      reason: `reviewer は changes_requested でしたが、auditor が Must 指摘をすべて却下したため approve として進めます(詳細: ${dir}/audit.md)`,
    };
  }
  if (audited === "need_human") {
    return { event: { type: "verdict", role: "reviewer", verdict: "need_human" }, reason: `auditor が人の判断を求めています(詳細: ${dir}/audit.md)` };
  }
  return outcomeOf(r, "reviewer", `${dir}/review.md`);
};

/** QAでアプリを起動するポート。並行するタスク同士でぶつからないよう、タスクごとに変える */
export function qaPortFor(taskId: number): number {
  return 4100 + (taskId % 800);
}

/** QA: 動くアプリで受け入れ条件を確かめる(フェーズ1はコマンドとHTTP)。コードを変えていないことはツール側で確かめる */
const qa: Handler = async (ctx, task) => {
  const tr = primaryRepo(ctx, task);
  const dir = taskDir(ctx.home, task.id);
  const evidence = join(dir, "qa-evidence");
  mkdirSync(evidence, { recursive: true });
  const before = headSha(tr.worktreePath, ctx.gitEnv);
  const port = qaPortFor(task.id);
  const r = await invokeRole(ctx, {
    roleName: "qa",
    taskId: task.id,
    cwd: tr.worktreePath,
    artifactsDir: dir,
    prompt: taskPrompt(ctx, task, "qa", [
      `- アプリは 127.0.0.1 で起動し、ポートは可能なら環境変数で PORT=${port} を使ってください(ほかのタスクとぶつからないように)。プロファイルの確認URLのポートは読み替えてください`,
      `- 証拠(HTTPの応答、ログ)は ${evidence} に保存し、qa-report.md から参照してください`,
      "- 確認が終わったら、起動したプロセスを必ず止めてください。コードは変更しないでください",
    ]),
  });
  if (headSha(tr.worktreePath, ctx.gitEnv) !== before || hasTrackedChanges(tr.worktreePath, ctx.gitEnv)) {
    return { event: { type: "run_error", reason: "QA がコードを変更しました" }, reason: `QA がコードを変更しました(コミット、または追跡しているファイルの変更)。worktree を確認してください: ${tr.worktreePath}` };
  }
  if (isDirty(tr.worktreePath, ctx.gitEnv)) {
    addEvent(ctx.db, { taskId: task.id, kind: "warning", payload: { message: "QA の後に未追跡のファイルが残っています(ビルド結果やログなど)" } });
  }
  if (r.ok && r.verdict === "passed") {
    addApproval(ctx.db, { taskId: task.id, repoId: tr.repoId, kind: "qa", result: "approved", commitSha: before });
    // デザインレビューで撮る画面(UI を伴うタスクで QA が返したもの)
    const screens = r.extra.screens as ScreenRequest[] | undefined;
    if (screens?.length) addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "qa_screens", payload: { screens } });
  }
  return outcomeOf(r, "qa", `${dir}/qa-report.md`);
};

/**
 * 実装後のデザインレビュー(設計メモ v0.13、4c)。QA が返した画面をツールが撮り(アプリはツールの sandbox-exec の中、
 * Chrome はサンドボックスの外)、デザインレビュー担当が画像と ui-spec.md を見比べる。撮れなければ、飛ばさず人の判断待ちにする
 */
const designReview: Handler = async (ctx, task) => {
  const tr = primaryRepo(ctx, task);
  const dir = taskDir(ctx.home, task.id);
  const outDir = join(dir, "screens");
  const requested = listEvents(ctx.db, task.id, 1000).filter((e) => e.kind === "qa_screens").at(-1)?.payload as { screens: ScreenRequest[] } | undefined;
  const screens: ScreenRequest[] = requested?.screens?.length ? requested.screens : [{ path: "/", note: "トップ(QA が撮る画面を返さなかったため)" }];
  let shots: Shot[];
  try {
    shots = await (ctx.capture ?? captureTaskScreens)(ctx, task, { worktree: tr.worktreePath, outDir, screens });
  } catch (e) {
    return stop(`画面を撮影できませんでした: ${(e as Error).message}`);
  }
  addEvent(ctx.db, { taskId: task.id, kind: "screens", payload: { shots } });
  const ok = shots.filter((s) => !s.error);
  if (ok.length === 0) return stop(`画面を撮影できませんでした: ${shots.map((s) => s.error).filter(Boolean).join(" / ") || "撮る画面がありません"}`);

  const r = await invokeRole(ctx, {
    roleName: "design_reviewer",
    taskId: task.id,
    cwd: tr.worktreePath,
    artifactsDir: dir,
    prompt: taskPrompt(ctx, task, "design_reviewer", [
      "- スクリーンショット(幅 1280 と 390 の、それぞれライトとダーク):",
      ...ok.map((s) => `  - ${join(outDir, s.file)}(${s.path}${screens.find((x) => x.path === s.path)?.note ? ` — ${screens.find((x) => x.path === s.path)!.note}` : ""}、幅 ${s.width}、${s.scheme === "dark" ? "ダーク" : "ライト"})`),
      ...(shots.length > ok.length ? [`- 撮影できなかった画面: ${shots.filter((s) => s.error).map((s) => `${s.file}(${s.error})`).join("、")}`] : []),
    ]),
  });
  return outcomeOf(r, "design_reviewer", `${dir}/design-review.md`);
};

const stop = (reason: string): HandlerOutcome => ({ event: { type: "run_error", reason }, reason });

/**
 * 統合: git の確認はコードで行い、LLM は PR 本文と変更履歴の下書きだけを書く。push はしない(人が行う)。
 * 完了したら、テスト基盤整備タスクならプロジェクトのテスト基盤を「あり」にする。
 */
const integrator: Handler = async (ctx, task) => {
  const tr = primaryRepo(ctx, task);
  const repo = getRepo(ctx.db, tr.repoId)!;
  const dir = taskDir(ctx.home, task.id);
  if (isDirty(tr.worktreePath, ctx.gitEnv)) return stop(`未コミットの変更があります: ${tr.worktreePath}`);
  const head = headSha(tr.worktreePath, ctx.gitEnv);
  const final = listValidApprovals(ctx.db, task.id).filter((a) => a.kind === "final" && a.repoId === tr.repoId).at(-1);
  if (!final || final.commitSha !== head) return stop("最終確認の承認の後にコミットが増えています。レビューからやり直してください(人の変更なら task return を使う)");
  if (!containsRef(tr.worktreePath, repo.defaultBranch, ctx.gitEnv)) {
    return stop(`ベース(${repo.defaultBranch})が進んでいます。agent-crew task update-base ${task.id} で追従してください`);
  }

  const base = mergeBase(tr.worktreePath, repo.defaultBranch, ctx.gitEnv);
  const commits = commitsSince(tr.worktreePath, base, ctx.gitEnv);
  writeFileSync(join(dir, "diffstat.txt"), diffStat(tr.worktreePath, base, ctx.gitEnv));
  const r = await invokeRole(ctx, {
    roleName: "integrator",
    taskId: task.id,
    cwd: tr.worktreePath,
    artifactsDir: dir,
    prompt: taskPrompt(ctx, task, "integrator", [
      `- ブランチ: ${tr.branchName}(ベース: ${repo.defaultBranch}、リポジトリ: ${repo.path})`,
      `- 変更の概要: ${join(dir, "diffstat.txt")}`,
      "- コミット:",
      ...commits.map((c) => `  - ${c.sha.slice(0, 12)} ${c.subject}(${c.agentRole ? `agent-crew ${c.agentRole}` : `人: ${c.author}`})`),
    ]),
  });
  if (r.ok && r.verdict === "done") {
    addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "integrated", payload: { repo: repo.path, branch: tr.branchName, head } });
    if (task.kind === "test_infra") {
      const profile = getRepoProfile(ctx.db, repo.id) as Profile | null;
      const command = testCommandFor(ctx, task, repo.id);
      if (profile) setRepoProfile(ctx.db, repo.id, { ...profile, testInfra: "present", commands: { ...profile.commands, test: command } });
      setProjectProfile(ctx.db, task.projectId, { testInfra: "present" });
    }
  }
  return outcomeOf(r, "integrator", `${dir}/pr-draft.md`);
};

/** 状態ごとの処理 */
export const HANDLERS: Partial<Record<Role, Handler>> = { planner, architect: design, implementer, reviewer, qa, design_reviewer: designReview, integrator };
