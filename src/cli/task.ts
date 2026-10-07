import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import { createTask, getProject, getTask, listArtifacts, listEvents, listRepos, listTaskRepos, listTasks, type Task } from "../db/store.ts";
import { createAppContext, type AppContext } from "../orchestrator/context.ts";
import { latestNeedsInputReason, runActive, runUntilIdle } from "../orchestrator/engine.ts";
import { returnTask, takeoverTask, updateBase } from "../orchestrator/handoff.ts";
import { answerTask, approveTask, cancelTask, rejectTask } from "../orchestrator/human.ts";
import { acquireRunLock, recoverStaleRuns } from "../orchestrator/lock.ts";
import { mustProject } from "../orchestrator/projects.ts";
import { NEEDS_HUMAN, STATE_LABELS } from "../orchestrator/states.ts";

function withContext<T>(fn: (ctx: AppContext) => T): T {
  const ctx = createAppContext();
  try {
    return fn(ctx);
  } finally {
    ctx.db.close();
  }
}

const mustTask = (ctx: AppContext, id: string): Task => {
  const t = getTask(ctx.db, Number(id));
  if (!t) throw new Error(`タスク ${id} がありません`);
  return t;
};

function line(ctx: AppContext, t: Task): string {
  const mark = NEEDS_HUMAN.includes(t.state) ? "★" : t.state === "human_working" ? "✋" : " ";
  return `${mark} #${String(t.id).padEnd(4)} ${getProject(ctx.db, t.projectId)!.name.padEnd(12)} ${STATE_LABELS[t.state].padEnd(10)} ${t.title}`;
}

const readText = (text?: string, file?: string) => (file ? readFileSync(file === "-" ? 0 : file, "utf8") : (text ?? ""));

export function registerTaskCommands(program: Command): void {
  const task = program.commands.find((c) => c.name() === "task") ?? program.command("task").description("タスクの操作");

  task
    .command("create")
    .description("タスクを作る")
    .requiredOption("--project <name>", "プロジェクト名")
    .requiredOption("--title <title>", "タイトル")
    .option("--body <text>", "本文(仕様・不具合の内容)")
    .option("--body-file <path>", "本文のファイル(- で標準入力)")
    .action((o: { project: string; title: string; body?: string; bodyFile?: string }) =>
      withContext((ctx) => {
        const p = mustProject(ctx.db, o.project);
        const t = createTask(ctx.db, { projectId: p.id, title: o.title, body: readText(o.body, o.bodyFile), sourceKind: o.bodyFile ? "paste" : "local" });
        console.log(`作成しました: #${t.id} ${t.title}(agent-crew run で開始します)`);
      }),
    );

  task
    .command("list")
    .description("タスクの一覧(★ は人の対応が必要)")
    .option("--project <name>", "プロジェクトで絞り込む")
    .option("--all", "完了・取り消しも表示する")
    .action((o: { project?: string; all?: boolean }) =>
      withContext((ctx) => {
        const projectId = o.project ? mustProject(ctx.db, o.project).id : undefined;
        for (const t of listTasks(ctx.db, { projectId })) {
          if (!o.all && (t.state === "done" || t.state === "cancelled")) continue;
          console.log(line(ctx, t));
        }
      }),
    );

  task
    .command("show <id>")
    .description("タスクの詳細(状態、理由、worktree、成果物、直近のイベント)")
    .action((id: string) =>
      withContext((ctx) => {
        const t = mustTask(ctx, id);
        console.log(`#${t.id} ${t.title}`);
        console.log(`状態: ${STATE_LABELS[t.state]}(${t.state})${t.heldFromState ? ` ← ${STATE_LABELS[t.heldFromState]}から` : ""}  差し戻し: ${t.reviewRounds}回  種別: ${t.kind}`);
        if (runActive(ctx.db, t.id)) console.log("⚠ エージェントが実行中です。worktree を触らないでください");
        if (t.state === "needs_input") console.log(`理由: ${latestNeedsInputReason(ctx.db, t.id) ?? "不明"}\n→ agent-crew task answer ${t.id} --message "..." で回答してください`);
        if (t.state === "awaiting_plan_approval") console.log(`→ plan.md を確認して agent-crew task approve ${t.id} --kind plan(または reject)`);
        if (t.state === "awaiting_final_approval") console.log(`→ 成果物を確認して agent-crew task approve ${t.id} --kind final(または reject)`);
        if (t.state === "done") {
          for (const e of listEvents(ctx.db, t.id, 1000).filter((e) => e.kind === "integrated")) {
            const p = e.payload as { repo: string; branch: string };
            console.log(`→ push と PR 作成は人が行います: git -C ${p.repo} push origin ${p.branch}(PR本文の下書き: pr-draft.md)`);
          }
        }
        const roles = new Map(listRepos(ctx.db, t.projectId).map((r) => [r.id, r.role]));
        for (const tr of listTaskRepos(ctx.db, t.id)) console.log(`worktree [${roles.get(tr.repoId)}]: ${tr.worktreePath}(${tr.branchName})`);
        const artifacts = new Map(listArtifacts(ctx.db, t.id).map((a) => [a.kind, a]));
        for (const a of artifacts.values()) if (existsSync(a.path)) console.log(`成果物 ${a.kind}: ${a.path}(${a.verdict ?? "-"})`);
        console.log("直近のイベント:");
        for (const e of listEvents(ctx.db, t.id, 10)) {
          console.log(`  ${e.createdAt.slice(11, 19)} ${e.kind.padEnd(14)} ${JSON.stringify(e.payload).slice(0, 120)}`);
        }
      }),
    );

  task
    .command("approve <id>")
    .description("計画(plan)または最終確認(final)を承認する")
    .requiredOption("--kind <kind>", "plan | final")
    .option("--comment <text>", "コメント")
    .action((id: string, o: { kind: "plan" | "final"; comment?: string }) =>
      withContext((ctx) => {
        approveTask(ctx, mustTask(ctx, id).id, o.kind, o.comment);
        console.log(`承認しました: #${id}(${STATE_LABELS[getTask(ctx.db, Number(id))!.state]})`);
      }),
    );

  task
    .command("reject <id>")
    .description("計画(plan)または最終確認(final)を却下して差し戻す")
    .requiredOption("--kind <kind>", "plan | final")
    .requiredOption("--comment <text>", "却下の理由(次の役割への入力になる)")
    .action((id: string, o: { kind: "plan" | "final"; comment: string }) =>
      withContext((ctx) => {
        rejectTask(ctx, mustTask(ctx, id).id, o.kind, o.comment);
        console.log(`差し戻しました: #${id}(${STATE_LABELS[getTask(ctx.db, Number(id))!.state]})`);
      }),
    );

  task
    .command("answer <id>")
    .description("人の回答待ち(needs_input)に回答して再開する")
    .option("--message <text>", "回答")
    .option("--message-file <path>", "回答のファイル(- で標準入力)")
    .action((id: string, o: { message?: string; messageFile?: string }) =>
      withContext((ctx) => {
        answerTask(ctx, mustTask(ctx, id).id, readText(o.message, o.messageFile));
        console.log(`回答しました: #${id}(${STATE_LABELS[getTask(ctx.db, Number(id))!.state]})`);
      }),
    );

  task
    .command("cancel <id>")
    .description("タスクを取り消す(worktree とブランチは残る)")
    .action((id: string) =>
      withContext((ctx) => {
        cancelTask(ctx, mustTask(ctx, id).id);
        console.log(`取り消しました: #${id}`);
      }),
    );

  task
    .command("takeover <id>")
    .description("人が引き取る(エージェントを止めてロックし、worktree で手作業する)")
    .action((id: string) =>
      withContext((ctx) => {
        const { worktrees } = takeoverTask(ctx, mustTask(ctx, id).id);
        console.log(`引き取りました: #${id}。エージェントは起動しません。次の worktree で作業し、変更はコミットしてください:`);
        for (const w of worktrees) console.log(`  code ${w}`);
        console.log(`終わったら agent-crew task return ${id} でエージェントに戻します`);
      }),
    );

  task
    .command("return <id>")
    .description("エージェントに戻す(未コミットの変更があれば拒否。人の変更があればレビューからやり直す)")
    .action((id: string) =>
      withContext((ctx) => {
        const r = returnTask(ctx, mustTask(ctx, id).id);
        console.log(`戻しました: #${id}(${STATE_LABELS[getTask(ctx.db, Number(id))!.state]})`);
        if (r.humanChanged) {
          console.log(`人の変更 ${r.commits.length} 件を記録しました(human-changes.md)。レビュー・QA・最終確認をやり直します`);
          console.log("方針を変えた場合は plan.md を直すか、task reject で計画からやり直してください");
        }
      }),
    );

  task
    .command("update-base <id>")
    .description("ベース(既定ブランチ)をタスクのブランチに取り込む")
    .action((id: string) =>
      withContext((ctx) => {
        const r = updateBase(ctx, mustTask(ctx, id).id);
        console.log(r.message);
        if (r.conflict) process.exitCode = 1;
      }),
    );

  program
    .command("run")
    .description("進められるタスクを、人の対応待ちになるまで進める")
    .action(async () => {
      const ctx = createAppContext();
      const release = acquireRunLock(ctx.home);
      try {
        const stale = recoverStaleRuns(ctx.db);
        if (stale) console.error(`前回中断された実行を ${stale} 件、失敗として記録しました`);
        const { steps } = await runUntilIdle(ctx, {
          onStep: (id) => {
            const t = getTask(ctx.db, id)!;
            console.error(`#${id} ${STATE_LABELS[t.state]}: ${t.title}`);
          },
        });
        console.log(`処理しました(${steps}段)。人の対応が必要なタスク:`);
        const waiting = listTasks(ctx.db).filter((t) => NEEDS_HUMAN.includes(t.state));
        for (const t of waiting) console.log(line(ctx, t));
        if (waiting.length === 0) console.log("  なし");
      } finally {
        release();
        ctx.db.close();
      }
    });
}
