import { existsSync, readFileSync, realpathSync } from "node:fs";
import { Command } from "commander";
import { openAppDb } from "../app.ts";
import { loadConfig } from "../config/config.ts";
import { applyRoleOverrides, loadRoles } from "../roles/roles.ts";
import { registerProjectCommands } from "./project.ts";
import { registerTaskCommands } from "./task.ts";
import { buildGui, guiBuildState } from "../server/gui-build.ts";
import { startServer } from "../server/server.ts";
import { createAppContext, type AppContext } from "../orchestrator/context.ts";
import { Worker } from "../orchestrator/worker.ts";
import { dataHome } from "../config/config.ts";
import { getTask, listRepos, listTaskRepos } from "../db/store.ts";
import { doctor, formatResults, probeSandbox } from "../doctor/index.ts";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export function createProgram(): Command {
  const program = new Command()
    .name("agent-crew")
    .description("役割別のAIエージェントにローカルで開発を進めさせる基盤ツール")
    .version(pkg.version);

  program
    .command("doctor")
    .description("前提ツール・認証・安全設定の状態を検査する")
    .option("--json", "結果をJSONで出力する")
    .option("--probe-sandbox", "claude -p(haiku)を実際に動かして安全設定を検査する(利用枠を少し使う)")
    .action(async (opts: { json?: boolean; probeSandbox?: boolean }) => {
      const results = doctor();
      if (opts.probeSandbox) {
        if (!opts.json) console.error("安全設定の実機検査を実行しています(1〜2分かかります)…");
        results.push(...(await probeSandbox()));
      }
      console.log(opts.json ? JSON.stringify(results, null, 2) : formatResults(results));
      if (results.some((r) => r.level === "error")) process.exitCode = 1;
    });

  program
    .command("roles")
    .description("役割定義(roles/*.md と設定の上書き)を一覧する")
    .action(() => {
      const roles = applyRoleOverrides(loadRoles(), loadConfig().roles);
      for (const r of roles.values()) {
        console.log([r.name.padEnd(12), r.model.padEnd(8), r.permissions.write.padEnd(10), r.verdicts.join("/"), r.output ?? "-"].join(" "));
      }
    });

  registerProjectCommands(program);

  const task = program.command("task").description("タスクの操作");

  task
    .command("worktree <id>")
    .description("タスクのworktreeのパスを表示する(役目、パス、ブランチ)")
    .action((id: string) => {
      const db = openAppDb();
      try {
        const t = getTask(db, Number(id));
        if (!t) throw new Error(`タスク ${id} がありません`);
        const roles = new Map(listRepos(db, t.projectId).map((r) => [r.id, r.role]));
        for (const tr of listTaskRepos(db, t.id)) {
          console.log([roles.get(tr.repoId), tr.worktreePath, tr.branchName].join("\t"));
        }
      } finally {
        db.close();
      }
    });

  registerTaskCommands(program);

  program
    .command("serve")
    .description("GUI を 127.0.0.1 で開く。エージェントを自動で進める常駐ワーカーも動かす")
    .option("--port <port>", "ポート", "4300")
    .option("--no-build", "GUI のビルドが古くてもビルドし直さない")
    .option("--no-worker", "常駐ワーカーを動かさず、読み取り専用で開く(操作は CLI)")
    .action(async (o: { port: string; build: boolean; worker: boolean }) => {
      const state = guiBuildState();
      if (state !== "ok" && o.build) {
        console.error(state === "missing" ? "GUI をビルドしています…" : "GUI のソースが更新されているので、ビルドし直しています…");
        if (!buildGui()) console.error("GUI のビルドに失敗しました。npm install を実行してから、もう一度起動してください");
      }
      let ctx: AppContext | undefined;
      let worker: Worker | undefined;
      if (o.worker) {
        ctx = createAppContext();
        worker = new Worker(ctx);
        worker.start();
        if (worker.status().state === "locked") console.error("CLI の agent-crew run が実行中です。終わったら自動で引き継ぎます");
      }
      // DB のパスは実体のパスで記録しているので、そろえる
      const home = ctx?.home ?? (existsSync(dataHome()) ? realpathSync(dataHome()) : dataHome());
      const s = await startServer({ home, port: Number(o.port), ops: ctx ? { ctx, worker } : undefined });
      console.log(`${s.url} で表示しています(127.0.0.1 のみ。${o.worker ? "常駐ワーカーが自動で進めます" : "読み取り専用"}。Ctrl-C で終了)`);
      let closing = false;
      process.on("SIGINT", async () => {
        if (closing) process.exit(130);
        closing = true;
        if (worker && worker.status().active.length > 0) console.error("実行中の役割を止めています…(もう一度 Ctrl-C で強制終了)");
        await worker?.close();
        await s.close();
        ctx?.db.close();
        process.exit(0);
      });
    });

  return program;
}

export async function main(argv: string[]): Promise<void> {
  try {
    await createProgram().parseAsync(argv);
  } catch (e) {
    console.error(`エラー: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
