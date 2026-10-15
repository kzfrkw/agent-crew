import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import { createTask, getProject, getTask, listArtifacts, listEvents, listRepos, listTaskRepos, listTasks, type Task } from "../db/store.ts";
import { createAppContext, type AppContext } from "../orchestrator/context.ts";
import { latestReason, runActive, runUntilIdle } from "../orchestrator/engine.ts";
import { returnTask, takeoverTask, updateBase } from "../orchestrator/handoff.ts";
import { answerTask, approveTask, cancelTask, rejectTask } from "../orchestrator/human.ts";
import { acquireRunLock, recoverStaleRuns } from "../orchestrator/lock.ts";
import { nextActions } from "../orchestrator/next-actions.ts";
import { buildTaskReport } from "../orchestrator/report.ts";
import { decideRetro, retroView } from "../orchestrator/retro.ts";
import { mustProject } from "../orchestrator/projects.ts";
import { createPlanningTask, criticQuestion } from "../orchestrator/planning.ts";
import type { HumanApprovalKind } from "../orchestrator/transitions.ts";
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
    .option("--source-url <url>", "取り込み元のページ(Notion など)の URL。報告(task report)に載る")
    .action((o: { project: string; title: string; body?: string; bodyFile?: string; sourceUrl?: string }) =>
      withContext((ctx) => {
        const p = mustProject(ctx.db, o.project);
        if (o.sourceUrl && !/^https?:\/\//.test(o.sourceUrl)) throw new Error("取り込み元の URL は http(s) で指定してください");
        const t = createTask(ctx.db, { projectId: p.id, title: o.title, body: readText(o.body, o.bodyFile), sourceKind: o.bodyFile || o.sourceUrl ? "paste" : "local", sourceUrl: o.sourceUrl });
        console.log(`作成しました: #${t.id} ${t.title}(agent-crew run で開始します)`);
      }),
    );

  task
    .command("plan")
    .description("企画のタスクを作る(調査 → 戦略 → 要件 → 構造・骨格 → 開発への引き渡し。フェーズ9)")
    .requiredOption("--project <name>", "プロジェクト名(既存サービスの新機能ならそのプロジェクト、新サービスなら project create で作った企画用のもの)")
    .requiredOption("--title <title>", "題")
    .option("--body <text>", "本文(作りたいもの、背景、想定するユーザー)")
    .option("--body-file <path>", "本文のファイル(- で標準入力)")
    .option("--docs <path>", "読ませる手元の資料(ファイルかフォルダの絶対パス。複数回指定できる)", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option("--source-url <url>", "取り込み元のページ(Notion など)の URL")
    .action((o: { project: string; title: string; body?: string; bodyFile?: string; docs: string[]; sourceUrl?: string }) =>
      withContext((ctx) => {
        const t = createPlanningTask(ctx, { projectName: o.project, title: o.title, body: readText(o.body, o.bodyFile), docs: o.docs, sourceUrl: o.sourceUrl });
        console.log(`企画を作りました: #${t.id} ${t.title}(agent-crew run で調査から始めます)`);
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
        const reason = t.state === "needs_input" || t.state === "failed" ? latestReason(ctx.db, t.id, t.state) : undefined;
        if (reason) console.log(`理由: ${reason}`);
        const question = t.kind === "planning" ? criticQuestion(ctx.db, t.id) : null;
        if (question && t.state.startsWith("awaiting_")) console.log(question);
        for (const a of nextActions(ctx.db, t)) if (a.command) console.log(`→ ${a.label}: ${a.command}`);
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
    .command("report <id>")
    .description("Notion などに貼る報告(概要・受け入れ条件・QA の結果・デザインレビュー・PR の下書き)を Markdown で出す。投稿は人が行う")
    .action((id: string) =>
      withContext((ctx) => {
        console.log(buildTaskReport(ctx.db, mustTask(ctx, id).id).markdown);
      }),
    );

  task
    .command("retro <id>")
    .description("振り返りの提案を見る。--adopt / --reject で採用・却下する(採用したものは規約か decisions.md に書き足す)")
    .option("--adopt <n>", "採用する提案の番号(複数回指定できる)", (v: string, acc: number[]) => [...acc, Number(v)], [] as number[])
    .option("--reject <n>", "却下する提案の番号(複数回指定できる)", (v: string, acc: number[]) => [...acc, Number(v)], [] as number[])
    .action((id: string, o: { adopt: number[]; reject: number[] }) =>
      withContext((ctx) => {
        const t = mustTask(ctx, id);
        for (const n of o.adopt) decideRetro(ctx, t.id, n, true, { force: true });
        for (const n of o.reject) decideRetro(ctx, t.id, n, false);
        const view = retroView(ctx.db, t.id);
        if (!view) return console.log("振り返りはまだありません");
        const mark = { pending: "未決", adopted: "採用", rejected: "却下" };
        for (const p of view.proposals) console.log(`[${p.index}] ${mark[p.status]}  ${p.target === "conventions" ? "規約" : "設計判断"}: ${p.text}`);
      }),
    );

  task
    .command("approve <id>")
    .description("計画(plan)・デザイン仕様(design)・最終確認(final)、企画の戦略(strategy)・要件(scope)・引き渡し(handoff)を承認する")
    .requiredOption("--kind <kind>", "plan | design | final | strategy | scope | handoff")
    .option("--target <project>", "引き渡し(handoff)の承認: 開発のタスクを作るプロジェクト(既定は企画のプロジェクト)")
    .option("--repo <path>", "引き渡し(handoff)の承認: 開発に使うリポジトリ(絶対パス。無いか空のフォルダなら git init する)を企画のプロジェクトに登録する")
    .option("--new-project <name>", "引き渡し(handoff)の承認: --repo のリポジトリで、別のプロジェクトを作る")
    .option("--comment <text>", "コメント")
    .option("--design", "計画の承認: 設計者を動かす(プランナーの判定を上書き)")
    .option("--no-design", "計画の承認: 設計者を動かさない")
    .option("--ui", "計画の承認: デザイナーを動かす(UI を伴う)")
    .option("--no-ui", "計画の承認: デザイナーを動かさない")
    .option("--split", "計画の承認: プランナーの案どおりに子タスクに分割して進める(8-2)")
    .action((id: string, o: { kind: HumanApprovalKind; comment?: string; design?: boolean; ui?: boolean; split?: boolean; target?: string; repo?: string; newProject?: string }) =>
      withContext((ctx) => {
        if (o.newProject && !o.repo) throw new Error("--new-project には --repo(リポジトリのフォルダ)が要ります");
        const t = mustTask(ctx, id);
        const override = o.kind === "plan" && (o.design !== undefined || o.ui !== undefined)
          ? { architect: o.design ?? t.design.architect, designer: o.ui ?? t.design.designer }
          : undefined;
        const devProject = o.repo ? { repoPath: o.repo, ...(o.newProject ? { name: o.newProject } : {}) } : undefined;
        approveTask(ctx, t.id, o.kind, o.comment, override, { split: o.split, targetProject: o.target, devProject });
        console.log(`承認しました: #${id}(${STATE_LABELS[getTask(ctx.db, Number(id))!.state]})`);
        if (devProject) {
          const name = o.newProject ?? getProject(ctx.db, t.projectId)!.name;
          console.log(`リポジトリを ${name} に登録しました。プロファイルを作って承認すると、開発のタスクが始まります:`);
          console.log(`  agent-crew project profile ${name}`);
          console.log(`  agent-crew project approve ${name}(テスト基盤を待たずに始めるなら --allow-without-tests)`);
        }
      }),
    );

  task
    .command("reject <id>")
    .description("計画・デザイン仕様・最終確認、企画の戦略・要件・引き渡しを却下して差し戻す")
    .requiredOption("--kind <kind>", "plan | design | final | strategy | scope | handoff")
    .requiredOption("--comment <text>", "却下の理由(次の役割への入力になる)")
    .action((id: string, o: { kind: HumanApprovalKind; comment: string }) =>
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
        const { steps, quota } = await runUntilIdle(ctx, {
          onStep: (id) => {
            const t = getTask(ctx.db, id)!;
            console.error(`#${id} ${STATE_LABELS[t.state]}: ${t.title}`);
          },
        });
        if (quota) console.log(`⏸ ${quota.reason}。新しい役割を起動しません(${new Date(quota.until).toLocaleString("ja-JP")} 以降に agent-crew run で再開できます)`);
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
