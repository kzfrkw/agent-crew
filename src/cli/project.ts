import type { Command } from "commander";
import { getProjectByName, getProjectWiring, getRepoProfile, listProjects, listRepos, listTasks } from "../db/store.ts";
import type { Profile } from "../roles/schemas.ts";
import { createAppContext } from "../orchestrator/context.ts";
import { projectDir } from "../orchestrator/paths.ts";
import {
  addRepository,
  approveProfile,
  mustProject,
  registerProject,
  repoProfileDir,
  reprofileProject,
  setProfileCommands,
  setRepoWiring,
  type ProfileOutcome,
} from "../orchestrator/projects.ts";

/** 役割に渡すコマンド(正本は DB のプロファイル) */
function printCommands(p: Profile): void {
  console.log("  役割に渡すコマンド(agent-crew project set で直す):");
  for (const [label, v] of [
    ["依存の準備", p.commands.install],
    ["ビルド", p.commands.build],
    ["テスト", p.commands.test],
    ["起動", p.commands.start],
    ["確認URL", p.startUrl],
  ] as const) console.log(`    ${label}: ${v ?? "なし"}`);
}

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
    .command("add-repo <name> <path>")
    .description("プロジェクトにリポジトリを追加し、プロジェクト把握担当にそのリポジトリのプロファイルを作らせる(複数リポジトリ)")
    .requiredOption("--role <role>", "リポジトリの役目(frontend / backend など。英小文字・数字・-・_)")
    .action(async (name: string, path: string, o: { role: string }) => {
      const ctx = createAppContext();
      try {
        console.error("プロジェクト把握担当が調査しています(数分かかります)…");
        const r = await addRepository(ctx, { name, repoPath: path, role: o.role });
        const p = mustProject(ctx.db, name);
        console.log(`追加しました: ${name} [${o.role}]`);
        reportProfile(name, repoProfileDir(ctx, p.id, o.role), r);
        console.log(`起動のつなぎ方(相手の URL など)は agent-crew project wire ${name} --role <役目> --env KEY={url:<役目>} で設定します`);
      } catch (e) {
        console.error((e as Error).message);
        process.exitCode = 1;
      } finally {
        ctx.db.close();
      }
    });

  project
    .command("wire <name>")
    .description("起動のつなぎ方: 役目のリポジトリを起動するときの環境変数({url:<役目>} / {origin:<役目>} / {port:<役目>} を使える。- で消す)")
    .requiredOption("--role <role>", "環境変数を渡すリポジトリの役目")
    .requiredOption("--env <pairs...>", "KEY=VALUE(複数可)")
    .action((name: string, o: { role: string; env: string[] }) => {
      const ctx = createAppContext();
      try {
        const env = Object.fromEntries(
          o.env.map((pair) => {
            const i = pair.indexOf("=");
            if (i <= 0) throw new Error(`KEY=VALUE の形で指定してください: ${pair}`);
            return [pair.slice(0, i), pair.slice(i + 1)];
          }),
        );
        const wiring = setRepoWiring(ctx, name, o.role, env);
        console.log(`設定しました: ${name} [${o.role}]`);
        for (const [k, v] of Object.entries(wiring[o.role] ?? {})) console.log(`  ${k}=${v}`);
      } catch (e) {
        console.error((e as Error).message);
        process.exitCode = 1;
      } finally {
        ctx.db.close();
      }
    });

  project
    .command("profile <name>")
    .description("プロファイルを作り直す(--role を省くと全リポジトリ)")
    .option("--role <role>", "作り直すリポジトリの役目")
    .action(async (name: string, o: { role?: string }) => {
      const ctx = createAppContext();
      try {
        const p = mustProject(ctx.db, name);
        reportProfile(name, o.role ? repoProfileDir(ctx, p.id, o.role) : projectDir(ctx.home, p.id), await reprofileProject(ctx, name, o.role));
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
    .command("set <name>")
    .description("役割に渡すコマンドを直す(正本は DB のプロファイル。profile.md を手で直しても反映されない)。- で「なし」")
    .option("--install <cmd>", "依存の準備(実装者が worktree で最初に1回実行する)")
    .option("--build <cmd>", "ビルド")
    .option("--test <cmd>", "全テスト(テストの再実行に使う)")
    .option("--start <cmd>", "起動(QA が 127.0.0.1 で起動する)")
    .option("--start-url <url>", "起動後に確認する URL")
    .option("--role <role>", "直すリポジトリの役目(既定は1つ目)")
    .action((name: string, o: { install?: string; build?: string; test?: string; start?: string; startUrl?: string; role?: string }) => {
      const ctx = createAppContext();
      try {
        const { role, ...patch } = o;
        const p = setProfileCommands(ctx, name, patch, role);
        console.log(`直しました: ${name}`);
        printCommands(p);
      } catch (e) {
        console.error((e as Error).message);
        process.exitCode = 1;
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
        for (const r of listRepos(ctx.db, p.id)) {
          console.log(`  [${r.role}] ${r.path}(既定ブランチ: ${r.defaultBranch})`);
          const prof = getRepoProfile(ctx.db, r.id) as Profile | null;
          if (prof) printCommands(prof);
          else console.log("  (プロファイルなし)");
          const env = getProjectWiring(ctx.db, p.id)[r.role];
          if (env && Object.keys(env).length) console.log(`  起動のつなぎ方: ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")}`);
        }
        for (const t of listTasks(ctx.db, { projectId: p.id })) console.log(`  #${t.id} ${t.state.padEnd(24)} ${t.title}`);
      } finally {
        ctx.db.close();
      }
    });
}
