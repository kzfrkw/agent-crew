import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addApproval, addEvent, listEvents, listRepos, setTaskDesign, setTaskRepos, getRepo, getRepoProfile, listTaskRepos, listValidApprovals, setProjectProfile, setRepoProfile, type Task } from "../db/store.ts";
import type { Judgment, Profile } from "../roles/schemas.ts";
import { changedFiles, commitsSince, containsRef, diffFromBase, diffStat, hasTrackedChanges, headSha, isDirty, mergeBase } from "../git/worktree.ts";
import { detectTestChanges, renderTestChanges } from "./test-changes.ts";
import { testCommandFor, verifyTests } from "./verify.ts";
import type { AppContext } from "./context.ts";
import { invokeRole, type InvokeResult, type ToolCommands } from "./invoke.ts";
import { projectDir, taskDir } from "./paths.ts";
import type { ScreenRequest } from "./context.ts";
import { captureTaskScreens } from "./screens.ts";
import type { Shot } from "../browser/chrome.ts";
import { platformOf, resolveServiceEnv } from "./projects.ts";
import { applyAudit, checkReviewConsistency, mustIndexes, type Finding } from "./review-findings.ts";
import { taskPrompt } from "./prompts.ts";
import { testFailureKey, type BounceInfo } from "./bounce.ts";
import type { Role, TaskEvent } from "./transitions.ts";

/** bounce は差し戻しの理由の要点(8-3。同じ理由が続いたら人に回す) */
export type HandlerOutcome = { event: TaskEvent; reason?: string; bounce?: BounceInfo };
export type Handler = (ctx: AppContext, task: Task) => Promise<HandlerOutcome>;

/** 役割の実行結果を、状態遷移の出来事にする */
export function outcomeOf(r: InvokeResult, role: Role, artifactPath?: string): HandlerOutcome {
  if (!r.ok) return { event: r.failure === "limit" ? { type: "limit_exceeded", reason: r.reason } : { type: "run_error", reason: r.reason }, reason: `${role}: ${r.reason}` };
  return {
    event: { type: "verdict", role, verdict: r.verdict },
    reason: `${role} の判定: ${r.verdict} — ${r.summary}${artifactPath ? `(詳細: ${artifactPath})` : ""}`,
  };
}

/** タスクの worktree を、計画で決まった順(task.repos)に並べる。1リポジトリのプロジェクトでは登録の順 */
export function orderedTaskRepos(ctx: AppContext, task: Task) {
  const repos = listRepos(ctx.db, task.projectId);
  const role = (repoId: number) => repos.find((r) => r.id === repoId)?.role ?? "";
  const trs = listTaskRepos(ctx.db, task.id).map((tr) => ({ ...tr, role: role(tr.repoId) }));
  if (task.repos) trs.sort((a, b) => task.repos!.indexOf(a.role) - task.repos!.indexOf(b.role));
  if (trs.length === 0) throw new Error(`タスク ${task.id} の worktree がありません`);
  return trs;
}

/** 代表の worktree(計画の順で最初のもの)。複数リポジトリでも、読むだけの役割の作業場所に使う */
export function primaryRepo(ctx: AppContext, task: Task) {
  return orderedTaskRepos(ctx, task)[0]!;
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

/**
 * 実装者。複数リポジトリでは、計画の順にリポジトリごとに動かす(設計メモ v0.14)。各実装者は自分の worktree にだけ書ける。
 * 前のリポジトリで止まったら(done 以外、コミットの確認に失敗)、次のリポジトリは動かさない
 */
/** Flutter のリポジトリなら、MCP の橋で代わりに実行するコマンド(テストは実装者が記録したものを優先)。web なら undefined */
export function toolCommandsFor(ctx: AppContext, repoId: number, task?: Task): ToolCommands | undefined {
  const profile = getRepoProfile(ctx.db, repoId) as Profile | null;
  const platform = platformOf(profile);
  if (platform === "web") return undefined;
  return {
    platform,
    commands: {
      test: task ? testCommandFor(ctx, task, repoId) : (profile?.commands.test ?? null),
      analyze: profile?.commands.analyze ?? null,
      // ビルドの確認はネイティブ iOS だけ(Flutter の iOS ビルドは重く、テストで足りる)
      build: platform === "ios" ? (profile?.commands.build ?? null) : null,
    },
  };
}

const implementer: Handler = async (ctx, task) => {
  const dir = taskDir(ctx.home, task.id);
  const trs = orderedTaskRepos(ctx, task);
  let last: HandlerOutcome | undefined;
  for (const tr of trs) {
    const before = headSha(tr.worktreePath, ctx.gitEnv);
    const r = await invokeRole(ctx, {
      roleName: "implementer",
      taskId: task.id,
      cwd: tr.worktreePath,
      artifactsDir: dir,
      prompt: taskPrompt(
        ctx,
        task,
        "implementer",
        trs.length > 1
          ? [`- 今回は [${tr.role}] のリポジトリ(worktree: ${tr.worktreePath})を実装してください。書けるのはこの worktree だけです(ほかのリポジトリは読むだけ)。インターフェース契約は design.md に従ってください`]
          : [],
      ),
      extraEnv: agentGitEnv("implementer"),
      toolCommands: toolCommandsFor(ctx, tr.repoId, task),
    });
    const label = trs.length > 1 ? `implementer [${tr.role}]` : "implementer";
    if (r.ok && r.verdict === "done") {
      // 実装者の申告ではなく、worktree の実際の状態で確かめる
      if (isDirty(tr.worktreePath, ctx.gitEnv)) {
        return { event: { type: "run_error", reason: "未コミットの変更が残っています" }, reason: `${label}: 未コミットの変更が残っています(${tr.worktreePath})` };
      }
      const commits = commitsSince(tr.worktreePath, before, ctx.gitEnv);
      if (commits.length === 0) {
        // 差し戻し・回答での再開の後で、ブランチに実装のコミットがすでにあれば、原因が環境(依存の壊れなど)でコードを直す必要が無いこともある。
        // 警告を残してテストの再実行・レビューに進める(虚偽の done は、そこでもう一度捕まる)。最初の実装でコミットが無いのは止める。
        // 差し戻しの回数は回答で0に戻るので、条件にしない(4b で判明)
        const already = commitsSince(tr.worktreePath, tr.baseSha, ctx.gitEnv).length > 0;
        if (!already) return { event: { type: "run_error", reason: "コミットがありません" }, reason: `${label}: done と判定しましたが、コミットがありません` };
        addEvent(ctx.db, {
          taskId: task.id,
          runId: r.runId,
          kind: "warning",
          payload: { message: `実装者${trs.length > 1 ? `(${tr.role})` : ""}が新しいコミットなしで done を返しました(理由: ${r.summary})。テストの再実行とレビューで確かめます` },
        });
      } else {
        addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "implemented", payload: { repo: tr.role, commits: commits.map((c) => ({ sha: c.sha, subject: c.subject })) } });
      }
      const testCommand = r.extra.testCommand;
      if (typeof testCommand === "string" && testCommand.trim()) {
        addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "test_command", payload: { command: testCommand.trim(), repoId: tr.repoId } });
      }
    }
    last = outcomeOf(r, "implementer", `${dir}/impl-notes.md`);
    if (!(r.ok && r.verdict === "done")) return last;
  }
  return last!;
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
  if (v.status === "failed") {
    const key = testFailureKey(v.output ?? "");
    return { event: { type: "tests_failed" }, reason: `テストの再実行が失敗しました(詳細: ${v.reportPath})`, bounce: { source: "tests", key, summary: `テストの再実行の失敗: ${key.split("\n").slice(0, 3).join(" / ").slice(0, 200)}` } };
  }

  const trs = orderedTaskRepos(ctx, task);
  const tr = trs[0]!;
  const multi = trs.length > 1;
  const dir = taskDir(ctx.home, task.id);
  // 前の周回の監査結果は、今回のレビューには当てはまらない。残すと実装者が古い「対応不要」を読んでしまう
  rmSync(join(dir, "audit.md"), { force: true });
  // 複数リポジトリでは、全リポジトリの差分をまとめて1人がレビューする(契約との整合を横断で確かめる。設計メモ v0.14)
  const perRepo = trs.map((x) => {
    const repo = getRepo(ctx.db, x.repoId)!;
    const base = mergeBase(x.worktreePath, repo.defaultBranch, ctx.gitEnv);
    const diff = diffFromBase(x.worktreePath, base, ctx.gitEnv);
    return {
      ...x,
      base,
      diff,
      head: headSha(x.worktreePath, ctx.gitEnv),
      tests: renderTestChanges(detectTestChanges({ nameStatus: changedFiles(x.worktreePath, base, ctx.gitEnv), diff })),
      human: commitsSince(x.worktreePath, base, ctx.gitEnv).filter((c) => !c.agentRole),
    };
  });
  const section = (role: string, body: string) => (multi ? `# [${role}]\n\n${body}` : body);
  writeFileSync(join(dir, "diff.patch"), perRepo.map((x) => section(x.role, x.diff)).join("\n"));
  writeFileSync(join(dir, "test-changes.md"), perRepo.map((x) => section(x.role, x.tests)).join("\n\n"));
  const human = perRepo.flatMap((x) => x.human.map((c) => ({ ...c, role: x.role })));

  const r = await invokeRole(ctx, {
    roleName: "reviewer",
    taskId: task.id,
    cwd: tr.worktreePath,
    artifactsDir: dir,
    prompt: taskPrompt(ctx, task, "reviewer", [
      `- 差分(${perRepo.map((x) => `${multi ? `[${x.role}] ` : ""}ベース ${x.base.slice(0, 12)} から HEAD ${x.head.slice(0, 12)}`).join("、")}): ${join(dir, "diff.patch")}`,
      ...(multi ? ["- 複数のリポジトリにまたがる変更です。design.md のインターフェース契約と、各リポジトリの実装が合っているかを横断で確かめてください"] : []),
      `- テストの変更の検出結果(必ず確認する): ${join(dir, "test-changes.md")}`,
      `- テストの再実行: ${v.status === "passed" ? `成功(${v.command})` : "テストコマンドが無いため未確認"}`,
      ...(human.length
        ? ["- 人の変更が含まれます(同じ基準でレビューする):", ...human.map((c) => `  - ${multi ? `[${c.role}] ` : ""}${c.sha.slice(0, 12)} ${c.subject}(${c.author})`)]
        : []),
    ]),
  });
  if (!r.ok) return outcomeOf(r, "reviewer", `${dir}/review.md`);

  const findings = r.extra.findings as Finding[];
  addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "review_findings", payload: { verdict: r.verdict, findings } });
  const inconsistent = checkReviewConsistency(r.verdict, findings);
  if (inconsistent) return { event: { type: "run_error", reason: inconsistent }, reason: `reviewer: ${inconsistent}(詳細: ${dir}/review.md)` };

  // 承認はリポジトリごとに、そのコミットに結びつける
  const approve = () => {
    for (const x of perRepo) addApproval(ctx.db, { taskId: task.id, repoId: x.repoId, kind: "review", result: "approved", commitSha: x.head });
  };
  if (r.verdict === "approve") {
    approve();
    return outcomeOf(r, "reviewer", `${dir}/review.md`);
  }
  if (r.verdict !== "changes_requested") return outcomeOf(r, "reviewer", `${dir}/review.md`);
  if (!ctx.config.review.audit) return { ...outcomeOf(r, "reviewer", `${dir}/review.md`), bounce: reviewBounce(findings) };

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
  return { ...outcomeOf(r, "reviewer", `${dir}/review.md`), bounce: reviewBounce(findings) };
};

/** レビューの差し戻しの要点: Must 指摘の見出しの集合。レビュワーが「前回と同じ」と判定したものがあれば繰り返し */
function reviewBounce(findings: Finding[]): BounceInfo {
  const musts = findings.filter((f) => f.severity === "must");
  return {
    source: "review",
    key: musts.map((f) => `${f.file}: ${f.title}`).sort().join("\n"),
    summary: `レビューの Must 指摘: ${musts.map((f) => f.title).join(" / ").slice(0, 200)}`,
    repeated: musts.some((f) => f.repeated),
  };
}

/** QAでアプリを起動するポート。並行するタスク同士でぶつからないよう、タスクごとに変える */
export function qaPortFor(taskId: number): number {
  return 4100 + (taskId % 800);
}

/** QA: 動くアプリで受け入れ条件を確かめる(フェーズ1はコマンドとHTTP)。コードを変えていないことはツール側で確かめる */
/**
 * 複数リポジトリのとき、QA が起動するリポジトリと環境変数のつなぎ方(設計メモ v0.14)。
 * 変更したリポジトリは worktree から、それ以外は本体(既定ブランチ)から。起動の順は登録の順
 */
function servicesPrompt(ctx: AppContext, task: Task): string[] {
  const repos = listRepos(ctx.db, task.projectId);
  if (repos.length < 2) return [];
  const trs = listTaskRepos(ctx.db, task.id);
  const lines = ["- このプロジェクトは複数のリポジトリでできています。次の順に、それぞれの起動コマンドで起動し、環境変数でつないでください:"];
  for (const r of repos) {
    const p = getRepoProfile(ctx.db, r.id) as Profile | null;
    const tr = trs.find((x) => x.repoId === r.id);
    let env: Record<string, string> = {};
    try {
      env = resolveServiceEnv(ctx.db, task.projectId, r.role);
    } catch (e) {
      lines.push(`  - [${r.role}] 環境変数のつなぎ方を解決できません: ${(e as Error).message}`);
    }
    const envText = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ");
    lines.push(
      `  - [${r.role}] 場所: ${tr ? tr.worktreePath : `${r.path}(本体。このタスクでは変更しない。書き込まない)`}、起動: ${p?.commands.start ?? "なし"}${envText ? `(環境変数: ${envText})` : ""}、確認 URL: ${p?.startUrl ?? "なし"}`,
    );
  }
  return lines;
}

const qa: Handler = async (ctx, task) => {
  const trs = orderedTaskRepos(ctx, task);
  const tr = trs[0]!;
  const dir = taskDir(ctx.home, task.id);
  const evidence = join(dir, "qa-evidence");
  mkdirSync(evidence, { recursive: true });
  const heads = new Map(trs.map((x) => [x.repoId, headSha(x.worktreePath, ctx.gitEnv)]));
  const before = heads.get(tr.repoId)!;
  const port = qaPortFor(task.id);
  const r = await invokeRole(ctx, {
    roleName: "qa",
    taskId: task.id,
    cwd: tr.worktreePath,
    artifactsDir: dir,
    prompt: taskPrompt(ctx, task, "qa", [
      ...(trs.length > 1 || listRepos(ctx.db, task.projectId).length > 1
        ? servicesPrompt(ctx, task)
        : [`- アプリは 127.0.0.1 で起動し、ポートは可能なら環境変数で PORT=${port} を使ってください(ほかのタスクとぶつからないように)。プロファイルの確認URLのポートは読み替えてください`]),
      `- 証拠(HTTPの応答、ログ)は ${evidence} に保存し、qa-report.md から参照してください`,
      "- 確認が終わったら、起動したプロセスを必ず止めてください。コードは変更しないでください",
    ]),
    toolCommands: toolCommandsFor(ctx, tr.repoId, task),
  });
  for (const x of trs) {
    if (headSha(x.worktreePath, ctx.gitEnv) !== heads.get(x.repoId) || hasTrackedChanges(x.worktreePath, ctx.gitEnv)) {
      return { event: { type: "run_error", reason: "QA がコードを変更しました" }, reason: `QA がコードを変更しました(コミット、または追跡しているファイルの変更)。worktree を確認してください: ${x.worktreePath}` };
    }
    if (isDirty(x.worktreePath, ctx.gitEnv)) {
      addEvent(ctx.db, { taskId: task.id, kind: "warning", payload: { message: `QA の後に未追跡のファイルが残っています(ビルド結果やログなど): ${x.worktreePath}` } });
    }
  }
  if (r.ok && r.verdict === "passed") {
    for (const x of trs) addApproval(ctx.db, { taskId: task.id, repoId: x.repoId, kind: "qa", result: "approved", commitSha: heads.get(x.repoId) });
    // デザインレビューで撮る画面(UI を伴うタスクで QA が返したもの)
    const screens = r.extra.screens as ScreenRequest[] | undefined;
    if (screens?.length) addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "qa_screens", payload: { screens } });
  }
  const out = outcomeOf(r, "qa", `${dir}/qa-report.md`);
  if (r.ok && r.verdict === "failed") {
    const failed = ((r.extra.failedCriteria ?? []) as string[]).map((c) => c.trim()).filter(Boolean);
    return { ...out, bounce: { source: "qa", key: [...failed].sort().join("\n"), summary: `QA で不合格の条件: ${failed.join(" / ").slice(0, 200)}` } };
  }
  return out;
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
      ok.some((s) => s.device)
        ? `- スクリーンショット(iOS シミュレータ ${ok.find((s) => s.device)!.device} の、ライトとダーク。アプリのテストが画面を開いて撮ったもの):`
        : "- スクリーンショット(幅 1280 と 390 の、それぞれライトとダーク):",
      ...ok.map((s) => `  - ${join(outDir, s.file)}(${s.path}${screens.find((x) => x.path === s.path)?.note ? ` — ${screens.find((x) => x.path === s.path)!.note}` : ""}、${s.device ? s.device : `幅 ${s.width}`}、${s.scheme === "dark" ? "ダーク" : "ライト"})`),
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
/**
 * 統合担当。git の確認(未コミット、最終確認の後のコミット、ベースへの追従)はコードがリポジトリごとに行い、
 * LLM は PR 本文の下書き(複数リポジトリならリポジトリごとの節と、マージの順・相互リンク)だけを書く(設計メモ v0.14)
 */
const integrator: Handler = async (ctx, task) => {
  const trs = orderedTaskRepos(ctx, task);
  const multi = trs.length > 1;
  const dir = taskDir(ctx.home, task.id);
  const finals = listValidApprovals(ctx.db, task.id).filter((a) => a.kind === "final");
  const items = [];
  for (const tr of trs) {
    const repo = getRepo(ctx.db, tr.repoId)!;
    const where = multi ? `[${tr.role}] ` : "";
    if (isDirty(tr.worktreePath, ctx.gitEnv)) return stop(`${where}未コミットの変更があります: ${tr.worktreePath}`);
    const head = headSha(tr.worktreePath, ctx.gitEnv);
    const final = finals.filter((a) => a.repoId === tr.repoId).at(-1);
    if (!final || final.commitSha !== head) return stop(`${where}最終確認の承認の後にコミットが増えています。レビューからやり直してください(人の変更なら task return を使う)`);
    if (!containsRef(tr.worktreePath, repo.defaultBranch, ctx.gitEnv)) {
      return stop(`${where}ベース(${repo.defaultBranch})が進んでいます。agent-crew task update-base ${task.id} で追従してください`);
    }
    const base = mergeBase(tr.worktreePath, repo.defaultBranch, ctx.gitEnv);
    items.push({ tr, repo, head, base, commits: commitsSince(tr.worktreePath, base, ctx.gitEnv), stat: diffStat(tr.worktreePath, base, ctx.gitEnv) });
  }
  writeFileSync(join(dir, "diffstat.txt"), items.map((x) => (multi ? `# [${x.tr.role}]\n${x.stat}` : x.stat)).join("\n\n"));
  const r = await invokeRole(ctx, {
    roleName: "integrator",
    taskId: task.id,
    cwd: items[0]!.tr.worktreePath,
    artifactsDir: dir,
    prompt: taskPrompt(ctx, task, "integrator", [
      ...items.flatMap((x) => [
        `- ${multi ? `[${x.tr.role}] ` : ""}ブランチ: ${x.tr.branchName}(ベース: ${x.repo.defaultBranch}、リポジトリ: ${x.repo.path})`,
        "  - コミット:",
        ...x.commits.map((c) => `    - ${c.sha.slice(0, 12)} ${c.subject}(${c.agentRole ? `agent-crew ${c.agentRole}` : `人: ${c.author}`})`),
      ]),
      `- 変更の概要: ${join(dir, "diffstat.txt")}`,
      ...(multi
        ? [`- 複数のリポジトリにまたがります。pr-draft.md にはリポジトリごとの節(タイトル案と本文)を書き、マージの順(${task.repos?.join(" → ") ?? items.map((x) => x.tr.role).join(" → ")})と、PR 同士の相互リンクの書き方を案内してください`]
        : []),
    ]),
  });
  if (r.ok && r.verdict === "done") {
    for (const x of items) {
      addEvent(ctx.db, { taskId: task.id, runId: r.runId, kind: "integrated", payload: { repo: x.repo.path, branch: x.tr.branchName, head: x.head } });
      if (task.kind === "test_infra") {
        const profile = getRepoProfile(ctx.db, x.repo.id) as Profile | null;
        const command = testCommandFor(ctx, task, x.repo.id);
        if (profile) setRepoProfile(ctx.db, x.repo.id, { ...profile, testInfra: "present", commands: { ...profile.commands, test: command } });
      }
    }
    if (task.kind === "test_infra") setProjectProfile(ctx.db, task.projectId, { testInfra: "present" });
  }
  return outcomeOf(r, "integrator", `${dir}/pr-draft.md`);
};

/** 状態ごとの処理 */
export const HANDLERS: Partial<Record<Role, Handler>> = { planner, architect: design, implementer, reviewer, qa, design_reviewer: designReview, integrator };
