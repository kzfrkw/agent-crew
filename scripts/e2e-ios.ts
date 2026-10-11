/**
 * ネイティブ iOS(SwiftUI)の一周の通し確認(フェーズ6b)。実機の claude を使うので利用枠を消費する。自動テストには含めない。
 *
 *   npm run e2e:ios
 *
 * 同梱の sample-ios を登録し、画面の変更を含むチケットを、
 * 計画 → デザイナー → 実装(テストとビルドは MCP の橋。シミュレータはツールが貸し出す)→ テストの再実行(ツール)→ レビュー → QA
 * → 撮影(XCUITest)とデザインレビュー → 統合まで通す。
 * 前提: macOS、Xcode と iOS シミュレータ(npx agent-crew doctor で確認できる)。
 *
 * 環境変数:
 *   E2E_MODEL  全役割のモデルを上書きする(既定 sonnet。"roles" なら roles/*.md の値をそのまま使う)
 *   E2E_KEEP   1 にすると、成功しても作業ディレクトリを残す
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDbPath } from "../src/app.ts";
import { openDb } from "../src/db/connection.ts";
import { getTask, listArtifacts, listEvents, listTaskRepos } from "../src/db/store.ts";
import { commitsSince } from "../src/git/worktree.ts";
import type { TaskState } from "../src/orchestrator/states.ts";

const root = new URL("..", import.meta.url).pathname;
const bin = join(root, "bin/agent-crew.js");
const model = process.env.E2E_MODEL ?? "sonnet";

// Claude Code のセッション内から実行すると TMPDIR が Claude の一時ディレクトリになり、サンドボックスが書き込みを拒否する。
// macOS では OS 本来の一時ディレクトリを使う
function baseTmp(): string {
  try {
    return execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
  } catch {
    return tmpdir();
  }
}

const work = join(baseTmp(), `agent-crew-e2e-ios-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const home = join(work, "home");
const started = Date.now();
const log = (msg: string) => console.log(`[e2e-ios ${Math.round((Date.now() - started) / 1000)}s] ${msg}`);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "E2E Human", GIT_AUTHOR_EMAIL: "human@example.com", GIT_COMMITTER_NAME: "E2E Human", GIT_COMMITTER_EMAIL: "human@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
const cli = (...args: string[]) => {
  log(`agent-crew ${args.join(" ")}`);
  const out = execFileSync(process.execPath, [bin, ...args], { env: { ...process.env, AGENT_CREW_HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  process.stdout.write(out.replace(/^/gm, "    "));
  return out;
};

function state(taskId: number): TaskState {
  const db = openDb(appDbPath(home));
  try {
    return getTask(db, taskId)!.state;
  } finally {
    db.close();
  }
}

/** サンプルを一時的な git リポジトリにする(push 先の bare リポジトリつき) */
function sampleRepo(): { repo: string; remote: string } {
  const repo = join(work, "sample-ios");
  const remote = join(work, "sample-ios-remote.git");
  cpSync(join(root, "fixtures", "sample-ios"), repo, { recursive: true });
  git(work, "init", "-q", "--bare", remote);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", remote);
  return { repo, remote };
}

function report(taskId: number, remote: string): { summary: string; ok: boolean } {
  const db = openDb(appDbPath(home));
  try {
    const rows = db
      .prepare("SELECT role, model, COUNT(*) AS n, ROUND(SUM(cost_usd), 3) AS cost, SUM(CAST((julianday(ended_at) - julianday(started_at)) * 86400 AS INTEGER)) AS sec FROM runs GROUP BY role, model ORDER BY MIN(id)")
      .all() as { role: string; model: string; n: number; cost: number; sec: number }[];
    const total = rows.reduce((a, r) => a + (r.cost ?? 0), 0);
    const task = getTask(db, taskId)!;
    const tr = listTaskRepos(db, taskId)[0]!;
    const artifacts = new Set(listArtifacts(db, taskId).map((a) => a.kind));
    const events = listEvents(db, taskId, 5000);
    const tools = events.filter((e) => e.kind === "tool_command").map((e) => e.payload as { purpose: string; role?: string; command: string; exitCode: number });
    const shots = (events.filter((e) => e.kind === "screens").at(-1)?.payload as { shots?: { file: string; device?: string; error?: string }[] } | undefined)?.shots ?? [];
    const commits = commitsSince(tr.worktreePath, tr.baseSha, process.env);
    const checks = [
      ["タスクが完了", task.state === "done"],
      ["デザイナーが動いた(ui-spec.md)", artifacts.has("ui-spec")],
      ...["plan", "impl-notes", "review", "qa-report", "design-review", "pr-draft"].map((k) => [`成果物 ${k}`, artifacts.has(k)] as const),
      ["テストの再実行はツールが行った(claude を使わない)", tools.some((t) => t.purpose === "verify" && t.exitCode === 0)],
      ["エージェントが MCP の橋でテスト/ビルドを実行した", tools.some((t) => t.purpose === "agent")],
      ["シミュレータでライト・ダークを撮った", shots.some((s) => !s.error && s.device && s.file.endsWith("-light.png")) && shots.some((s) => !s.error && s.file.endsWith("-dark.png"))],
      ["エージェントのコミットに trailer", commits.some((c) => c.agentRole === "implementer")],
      ["ローカルブランチ", git(join(work, "sample-ios"), "branch", "--list", tr.branchName) !== ""],
      ["remote に push されていない", git(remote, "branch", "--list") === ""],
    ] as const;
    const lines = [
      `## ${new Date().toISOString()} ネイティブ iOS(SwiftUI)(モデル: ${model})`,
      "",
      `- 所要時間: ${Math.round((Date.now() - started) / 60000)}分`,
      `- 費用(見積もり)の合計: $${total.toFixed(3)}`,
      `- 撮影: ${shots.map((s) => `${s.file}${s.error ? "(失敗)" : ""}`).join("、") || "なし"}`,
      "",
      "| 役割 | モデル | 回数 | 費用 | 秒 |",
      "|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.role} | ${r.model} | ${r.n} | $${r.cost ?? 0} | ${r.sec ?? 0} |`),
      "",
      "ツールが代わりに実行したコマンド:",
      ...tools.map((t) => `- [${t.purpose === "verify" ? "テストの再実行" : t.role}] ${t.command} → 終了コード ${t.exitCode}`),
      "",
      ...checks.map(([name, ok]) => `- ${ok ? "✓" : "✗"} ${name}`),
      "",
      "コミット:",
      ...commits.map((c) => `- ${c.subject}(${c.agentRole ? `agent-crew ${c.agentRole}` : c.author})`),
      "",
    ];
    return { summary: lines.join("\n"), ok: checks.every(([, ok]) => ok) };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  log(`作業ディレクトリ: ${work}`);
  mkdirSync(home, { recursive: true });
  const { repo, remote } = sampleRepo();
  if (model !== "roles") {
    const names = ["profiler", "planner", "architect", "designer", "implementer", "reviewer", "auditor", "qa", "design_reviewer", "integrator"];
    writeFileSync(join(home, "config.json"), JSON.stringify({ roles: Object.fromEntries(names.map((r) => [r, { model }])) }, null, 2));
  }

  cli("project", "add", repo, "--name", "orders-ios");
  // 調査の結果に左右されないよう、種類とコマンドを決めておく(人がプロファイルを直す想定)
  cli(
    "project", "set", "orders-ios", "--platform", "ios", "--install", "-", "--analyze", "-", "--start", "-", "--start-url", "-",
    "--test", "xcodebuild test -scheme Orders -destination 'platform=iOS Simulator,id={simulator}' -derivedDataPath build/DerivedData -only-testing:OrdersTests -quiet",
    "--build", "xcodebuild build -scheme Orders -destination 'generic/platform=iOS Simulator' -derivedDataPath build/DerivedData -quiet",
    "--screens", "OrdersUITests/ScreensUITests",
  );
  const approved = cli("project", "approve", "orders-ios", "--allow-without-tests");
  const infra = /整備タスクを作りました: #(\d+)/.exec(approved);
  if (infra) cli("task", "cancel", infra[1]!);

  const body = join(work, "ticket.md");
  writeFileSync(
    body,
    "注文の一覧に、注文の状態(受付 / 発送済み)を表示してほしい。\n\n- 各注文に状態を持たせる(1 と 3 は受付、2 は発送済み)\n- 一覧の各行に、状態を小さなラベルで表示する。発送済みは受付と見分けがつくこと\n- ライト / ダークのどちらでも読めること\n- 既存の表示(番号、品目、数量)は変えない\n",
  );
  const created = cli("task", "create", "--project", "orders-ios", "--title", "注文の一覧に状態を表示する", "--body-file", body, "--source-url", "https://www.notion.so/example/orders-status");
  const id = Number(/#(\d+)/.exec(created)![1]);

  for (let i = 0; i < 14; i++) {
    cli("run");
    const s = state(id);
    log(`#${id}: ${s}`);
    if (s === "done") break;
    // 画面が変わるタスクなので、デザイナーを必ず動かす(撮影とデザインレビューまで通すため)
    if (s === "awaiting_plan_approval") cli("task", "approve", String(id), "--kind", "plan", "--ui", "--comment", "この計画で進めてください");
    else if (s === "awaiting_design_approval") cli("task", "approve", String(id), "--kind", "design");
    else if (s === "awaiting_final_approval") cli("task", "approve", String(id), "--kind", "final", "--comment", "確認しました");
    else {
      cli("task", "show", String(id));
      throw new Error(`タスク #${id} が ${s} で止まりました`);
    }
  }
  cli("task", "show", String(id));
  // 書き戻し(6c): Notion に貼る報告が組み立てられること
  const reportMd = cli("task", "report", String(id));
  if (!reportMd.includes("https://www.notion.so/example/orders-status") || !reportMd.includes("### QA の結果")) throw new Error("報告(task report)に元のページか QA の結果がありません");

  const { summary, ok } = report(id, remote);
  console.log(`\n${summary}`);
  appendFileSync(join(root, "docs/e2e-log.md"), "\n" + summary + "\n");
  if (!ok) throw new Error("確認項目に失敗があります");
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
  else log(`作業ディレクトリを残しました: ${work}`);
  log("完了");
}

main().catch((e) => {
  console.error(`\n[e2e-ios] 失敗: ${(e as Error).message}\n作業ディレクトリ: ${work}`);
  if (existsSync(join(home, "agent-crew.db"))) console.error(`調査: AGENT_CREW_HOME=${home} npx agent-crew task show 2`);
  process.exitCode = 1;
});
