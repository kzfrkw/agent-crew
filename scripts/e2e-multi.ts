/**
 * 複数リポジトリの一周の通し確認(フェーズ5)。実機の claude を使うので利用枠を消費する。自動テストには含めない。
 *
 *   npm run e2e:multi
 *
 * 同梱の sample-api(バックエンド)と sample-front(画面)を1つのプロジェクトに登録し、
 * 両方にまたがるチケットを、計画 → 設計(契約)→ 実装(リポジトリごと)→ レビュー → QA → 統合まで通す。
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
import { getTask, listArtifacts, listRepos, listTaskRepos } from "../src/db/store.ts";
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

const work = join(baseTmp(), `agent-crew-e2e-multi-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const home = join(work, "home");
const started = Date.now();
const log = (msg: string) => console.log(`[e2e-multi ${Math.round((Date.now() - started) / 1000)}s] ${msg}`);
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
function sampleRepo(name: string): { repo: string; remote: string } {
  const repo = join(work, name);
  const remote = join(work, `${name}-remote.git`);
  cpSync(join(root, "fixtures", name), repo, { recursive: true });
  git(work, "init", "-q", "--bare", remote);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", remote);
  return { repo, remote };
}

function report(taskId: number, remotes: string[]): { summary: string; ok: boolean } {
  const db = openDb(appDbPath(home));
  try {
    const rows = db
      .prepare("SELECT role, model, COUNT(*) AS n, ROUND(SUM(cost_usd), 3) AS cost, SUM(CAST((julianday(ended_at) - julianday(started_at)) * 86400 AS INTEGER)) AS sec FROM runs GROUP BY role, model ORDER BY MIN(id)")
      .all() as { role: string; model: string; n: number; cost: number; sec: number }[];
    const total = rows.reduce((a, r) => a + (r.cost ?? 0), 0);
    const task = getTask(db, taskId)!;
    const repos = listRepos(db, task.projectId);
    const trs = listTaskRepos(db, taskId);
    const artifacts = new Set(listArtifacts(db, taskId).map((a) => a.kind));
    const perRepo = trs.map((tr) => {
      const repo = repos.find((r) => r.id === tr.repoId)!;
      return { role: repo.role, path: repo.path, branch: tr.branchName, commits: commitsSince(repo.path, tr.baseSha, process.env, tr.branchName) }; // worktree は片付け済み(7-2)
    });
    const checks = [
      ["タスクが完了", task.state === "done"],
      ["変更するリポジトリが2つ(計画の repos)", (task.repos ?? []).length === 2],
      ["設計者が動いた(design.md、インターフェース契約)", artifacts.has("design")],
      ...["plan", "impl-notes", "review", "qa-report", "pr-draft"].map((k) => [`成果物 ${k}`, artifacts.has(k)] as const),
      ...perRepo.map((r) => [`[${r.role}] ローカルブランチ`, git(r.path, "branch", "--list", r.branch) !== ""] as const),
      ...perRepo.map((r) => [`[${r.role}] エージェントのコミットに trailer`, r.commits.some((c) => c.agentRole === "implementer")] as const),
      ["remote に push されていない", remotes.every((remote) => git(remote, "branch", "--list") === "")],
    ] as const;
    const lines = [
      `## ${new Date().toISOString()} 複数リポジトリ(モデル: ${model})`,
      "",
      `- 所要時間: ${Math.round((Date.now() - started) / 60000)}分`,
      `- 費用(見積もり)の合計: $${total.toFixed(3)}`,
      `- 変更したリポジトリ(実装した順): ${(task.repos ?? []).join(" → ")}`,
      "",
      "| 役割 | モデル | 回数 | 費用 | 秒 |",
      "|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.role} | ${r.model} | ${r.n} | $${r.cost ?? 0} | ${r.sec ?? 0} |`),
      "",
      ...checks.map(([name, ok]) => `- ${ok ? "✓" : "✗"} ${name}`),
      "",
      "コミット:",
      ...perRepo.flatMap((r) => r.commits.map((c) => `- [${r.role}] ${c.subject}(${c.agentRole ? `agent-crew ${c.agentRole}` : c.author})`)),
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
  const api = sampleRepo("sample-api");
  const front = sampleRepo("sample-front");
  if (model !== "roles") {
    const names = ["profiler", "planner", "architect", "designer", "implementer", "reviewer", "auditor", "qa", "design_reviewer", "integrator"];
    writeFileSync(join(home, "config.json"), JSON.stringify({ notify: false, roles: Object.fromEntries(names.map((r) => [r, { model }])) }, null, 2));
  }

  // 起動の順は登録の順: API を先に登録する
  cli("project", "add", api.repo, "--name", "shop", "--role", "backend");
  cli("project", "add-repo", "shop", front.repo, "--role", "frontend");
  // 調査の結果に左右されないよう、起動コマンドと確認 URL を決めておく(人がプロファイルを直す想定)
  cli("project", "set", "shop", "--role", "backend", "--start", "PORT=3101 node server.js", "--start-url", "http://127.0.0.1:3101/api/orders", "--test", "npm test", "--install", "-", "--build", "-");
  cli("project", "set", "shop", "--role", "frontend", "--start", "PORT=3100 node server.js", "--start-url", "http://127.0.0.1:3100/", "--test", "npm test", "--install", "-", "--build", "-");
  cli("project", "wire", "shop", "--role", "frontend", "--env", "API_URL={origin:backend}");
  const approved = cli("project", "approve", "shop", "--allow-without-tests");
  const infra = /整備タスクを作りました: #(\d+)/.exec(approved);
  if (infra) cli("task", "cancel", infra[1]!);

  const body = join(work, "ticket.md");
  writeFileSync(
    body,
    "注文に状態(受付 / 発送済み)を持たせ、画面の注文の一覧に状態の列を表示してほしい。\n\n- API: `GET /api/orders` と `GET /api/orders/:id` の各注文に `status`(`received` または `shipped`)を含める\n- 画面: 注文の一覧に「状態」の列を足し、受付 / 発送済み と日本語で表示する\n- 既存の項目(id、品目、数量)は変えない\n",
  );
  const created = cli("task", "create", "--project", "shop", "--title", "注文に状態を持たせ、画面に表示する", "--body-file", body);
  const id = Number(/#(\d+)/.exec(created)![1]);

  // 人の承認が要る状態では承認して、完了するまで進める
  for (let i = 0; i < 12; i++) {
    cli("run");
    const s = state(id);
    log(`#${id}: ${s}`);
    if (s === "done") break;
    if (s === "awaiting_plan_approval") cli("task", "approve", String(id), "--kind", "plan", "--comment", "この計画で進めてください");
    else if (s === "awaiting_design_approval") cli("task", "approve", String(id), "--kind", "design");
    else if (s === "awaiting_final_approval") cli("task", "approve", String(id), "--kind", "final", "--comment", "確認しました");
    else {
      cli("task", "show", String(id));
      throw new Error(`タスク #${id} が ${s} で止まりました`);
    }
  }
  cli("task", "show", String(id));

  const { summary, ok } = report(id, [api.remote, front.remote]);
  console.log(`\n${summary}`);
  const logPath = join(root, "docs/e2e-log.md");
  appendFileSync(logPath, "\n" + summary + "\n");
  if (!ok) throw new Error("確認項目に失敗があります");
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
  else log(`作業ディレクトリを残しました: ${work}`);
  log("完了");
}

main().catch((e) => {
  console.error(`\n[e2e-multi] 失敗: ${(e as Error).message}\n作業ディレクトリ: ${work}`);
  if (existsSync(join(home, "agent-crew.db"))) console.error(`調査: AGENT_CREW_HOME=${home} npx agent-crew task show 2`);
  process.exitCode = 1;
});
