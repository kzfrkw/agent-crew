import type { Command } from "commander";
import { getProjectByName, listProjects, listRepos, listTasks } from "../db/store.ts";
import { createAppContext } from "../orchestrator/context.ts";
import { projectDir } from "../orchestrator/paths.ts";
import { approveProfile, mustProject, registerProject, reprofileProject, type ProfileOutcome } from "../orchestrator/projects.ts";

function reportProfile(name: string, dir: string, r: ProfileOutcome): void {
  if (!r.ok) {
    console.log(`プロファイルを作れませんでした: ${r.reason}`);
    console.log(`原因を直してから agent-crew project profile ${name} で作り直してください`);
    process.exitCode = 1;
    return;
  }
  console.log(`プロジェクト把握担当: ${r.verdict} — ${r.summary}`);
  console.log(`テスト基盤: ${r.profile.testInfra}`);
  console.log(`プロファイル: ${dir}/profile.md`);
  if (r.verdict === "need_human") console.log("人への質問があります。profile.md を確認してください");
  console.log(`内容を確認・修正したら agent-crew project approve ${name} で承認してください`);
}

export function registerProjectCommands(program: Command): void {
  const project = program.command("project").description("プロジェクト(対象リポジトリ)の登録と管理");

  project
    .command("add <path>")
    .description("リポジトリを登録し、プロジェクト把握担当にプロファイルを作らせる")
    .requiredOption("--name <name>", "プロジェクト名(英数字・-・_)")
    .option("--role <role>", "リポジトリの役目", "main")
    .action(async (path: string, opts: { name: string; role: string }) => {
      const ctx = createAppContext();
      try {
        console.error("プロジェクト把握担当が調査しています(数分かかります)…");
        const r = await registerProject(ctx, { name: opts.name, repoPath: path, role: opts.role });
        const p = getProjectByName(ctx.db, opts.name)!;
        console.log(`登録しました: ${opts.name}`);
        reportProfile(opts.name, projectDir(ctx.home, p.id), r);
      } finally {
        ctx.db.close();
      }
    });

  project
    .command("profile <name>")
    .description("プロファイルを作り直す")
    .action(async (name: string) => {
      const ctx = createAppContext();
      try {
        const p = mustProject(ctx.db, name);
        reportProfile(name, projectDir(ctx.home, p.id), await reprofileProject(ctx, name));
      } finally {
        ctx.db.close();
      }
    });

  project
    .command("approve <name>")
    .description("プロファイルを承認する(テスト基盤が無ければ整備タスクを作る)")
    .option("--allow-without-tests", "テスト基盤の整備前でも通常タスクの開始を許可する")
    .action((name: string, opts: { allowWithoutTests?: boolean }) => {
      const ctx = createAppContext();
      try {
        const r = approveProfile(ctx, name, opts);
        console.log(`承認しました: ${name}`);
        if (r.testInfraTask) {
          console.log(`テスト基盤が ${r.project.testInfra} のため、整備タスクを作りました: #${r.testInfraTask.id} ${r.testInfraTask.title}`);
          console.log(r.project.allowWithoutTests ? "通常タスクも開始できます(例外を許可済み)" : "整備が完了するまで、通常タスクは開始しません");
        }
      } finally {
        ctx.db.close();
      }
    });

  project
    .command("list")
    .description("プロジェクトの一覧(名前、プロファイル、テスト基盤、タスク数)")
    .action(() => {
      const ctx = createAppContext();
      try {
        for (const p of listProjects(ctx.db)) {
          console.log([p.name.padEnd(16), p.profileStatus.padEnd(9), p.testInfra.padEnd(13), `${listTasks(ctx.db, { projectId: p.id }).length} tasks`].join(" "));
        }
      } finally {
        ctx.db.close();
      }
    });

  project
    .command("show <name>")
    .description("プロジェクトの詳細")
    .action((name: string) => {
      const ctx = createAppContext();
      try {
        const p = mustProject(ctx.db, name);
        console.log(`${p.name}  プロファイル: ${p.profileStatus}  テスト基盤: ${p.testInfra}${p.allowWithoutTests ? "(例外を許可済み)" : ""}`);
        console.log(`データ: ${projectDir(ctx.home, p.id)}`);
        for (const r of listRepos(ctx.db, p.id)) console.log(`  [${r.role}] ${r.path}(既定ブランチ: ${r.defaultBranch})`);
        for (const t of listTasks(ctx.db, { projectId: p.id })) console.log(`  #${t.id} ${t.state.padEnd(24)} ${t.title}`);
      } finally {
        ctx.db.close();
      }
    });
}
