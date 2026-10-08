/**
 * 一周の通し確認(フェーズ1のステップ15)。実機の claude を使うので利用枠を消費する。自動テストには含めない。
 *
 *   npm run e2e
 *
 * 環境変数:
 *   E2E_MODEL    全役割のモデルを上書きする(既定 sonnet。"roles" なら roles/*.md の値をそのまま使う)
 *   E2E_HANDOFF  0 にすると、人への引き継ぎ(takeover → 人のコミット → return)を省く
 *   E2E_KEEP     1 にすると、成功しても作業ディレクトリを残す
 *
 * プロジェクト把握担当がテスト基盤を「不十分」と判断すると整備タスクが自動で作られるが、
 * 通し確認ではチケットの一周に絞るため、例外を許可して整備タスクは取り消す。
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDbPath } from "../src/app.ts";
import { openDb } from "../src/db/connection.ts";
import { getTask, listArtifacts, listTaskRepos } from "../src/db/store.ts";
import { commitsSince } from "../src/git/worktree.ts";
import type { TaskState } from "../src/orchestrator/states.ts";

const root = new URL("..", import.meta.url).pathname;
const bin = join(root, "bin/agent-crew.js");
const model = process.env.E2E_MODEL ?? "sonnet";
const handoff = process.env.E2E_HANDOFF !== "0";

// Claude Code のセッション内から実行すると TMPDIR が Claude の一時ディレクトリになり、サンドボックスが書き込みを拒否する。
// macOS では OS 本来の一時ディレクトリを使う
function baseTmp(): string {
  try {
    return execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
  } catch {
    return tmpdir();
  }
}

const work = join(baseTmp(), `agent-crew-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const home = join(work, "home");
const repo = join(work, "sample-web");
const remote = join(work, "remote.git");
const started = Date.now();
const log = (msg: string) => console.log(`[e2e ${Math.round((Date.now() - started) / 1000)}s] ${msg}`);

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

function expectState(taskId: number, expected: TaskState): void {
  const actual = state(taskId);
  if (actual !== expected) {
    cli("task", "show", String(taskId));
    throw new Error(`タスク #${taskId} の状態が ${expected} ではなく ${actual} です`);
  }
  log(`#${taskId}: ${actual} ✓`);
}

function setup(): void {
  mkdirSync(home, { recursive: true });
  cpSync(join(root, "fixtures/sample-web"), repo, { recursive: true });
  git(work, "init", "-q", "--bare", remote);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", remote);
  if (model !== "roles") {
    const roles = Object.fromEntries(["profiler", "planner", "implementer", "reviewer", "qa", "integrator"].map((r) => [r, { model }]));
    writeFileSync(join(home, "config.json"), JSON.stringify({ roles }, null, 2));
  }
}

function report(taskId: number): { summary: string; ok: boolean } {
  const db = openDb(appDbPath(home));
  try {
    const rows = db
      .prepare("SELECT role, model, COUNT(*) AS n, ROUND(SUM(cost_usd), 3) AS cost, SUM(CAST((julianday(ended_at) - julianday(started_at)) * 86400 AS INTEGER)) AS sec FROM runs GROUP BY role, model ORDER BY MIN(id)")
      .all() as { role: string; model: string; n: number; cost: number; sec: number }[];
    const total = rows.reduce((a, r) => a + (r.cost ?? 0), 0);
    const tr = listTaskRepos(db, taskId)[0]!;
    const commits = commitsSince(tr.worktreePath, tr.baseSha, process.env);
    const artifacts = new Set(listArtifacts(db, taskId).map((a) => a.kind));
    const checks = [
      ["タスクが完了", getTask(db, taskId)!.state === "done"],
      ...["plan", "impl-notes", "review", "qa-report", "pr-draft"].map((k) => [`成果物 ${k}`, artifacts.has(k)] as const),
      ["ローカルブランチ", git(repo, "branch", "--list", tr.branchName) !== ""],
      ["remote に push されていない", git(remote, "branch", "--list") === ""],
      ["エージェントのコミットに trailer", commits.some((c) => c.agentRole === "implementer")],
      ...(handoff ? [["人のコミットを区別", commits.some((c) => c.agentRole === null && c.author === "E2E Human")] as const] : []),
    ] as const;
    const lines = [
      `## ${new Date().toISOString()}(モデル: ${model}${handoff ? "、引き継ぎあり" : ""})`,
      "",
      `- 所要時間: ${Math.round((Date.now() - started) / 60000)}分`,
      `- 費用(見積もり)の合計: $${total.toFixed(3)}`,
      "",
      "| 役割 | モデル | 回数 | 費用 | 秒 |",
      "|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.role} | ${r.model} | ${r.n} | $${r.cost ?? 0} | ${r.sec ?? 0} |`),
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
  setup();
  cli("project", "add", repo, "--name", "sample");
  const approved = cli("project", "approve", "sample", "--allow-without-tests");
  const infra = /整備タスクを作りました: #(\d+)/.exec(approved);
  if (infra) cli("task", "cancel", infra[1]!);

  const body = join(work, "ticket.md");
  writeFileSync(
    body,
    "在庫が0のアイテムは、一覧APIに出さないでほしい。\n\n- GET /api/items は stock が 0 のアイテムを含めない\n- GET /api/items/:id は、在庫が0でもこれまでどおり返す\n",
  );
  const created = cli("task", "create", "--project", "sample", "--title", "在庫0のアイテムを一覧から除外する", "--body-file", body);
  const id = Number(/#(\d+)/.exec(created)![1]);

  cli("run");
  expectState(id, "awaiting_plan_approval");
  cli("task", "approve", String(id), "--kind", "plan", "--comment", "この計画で進めてください");

  cli("run");
  expectState(id, "awaiting_final_approval");

  if (handoff) {
    const out = cli("task", "takeover", String(id));
    const wt = /code (\S+)/.exec(out)![1]!;
    // 人が手で直す想定: README に、一覧から在庫0を除外したことを書き足す
    appendFileSync(join(wt, "README.md"), "\n- 一覧(`GET /api/items`)には在庫0のアイテムを含めない\n");
    git(wt, "add", "README.md");
    git(wt, "commit", "-q", "-m", "docs: 一覧の仕様を README に追記");
    cli("task", "return", String(id));
    expectState(id, "reviewing");
    cli("run");
    expectState(id, "awaiting_final_approval");
  }

  cli("task", "approve", String(id), "--kind", "final", "--comment", "確認しました");
  cli("run");
  expectState(id, "done");
  cli("task", "show", String(id));

  const { summary, ok } = report(id);
  console.log(`\n${summary}`);
  const logPath = join(root, "docs/e2e-log.md");
  if (!existsSync(logPath)) writeFileSync(logPath, "# 一周の通し確認の記録(npm run e2e)\n\n");
  appendFileSync(logPath, summary + "\n");
  if (!ok) throw new Error("確認項目に失敗があります");
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
  else log(`作業ディレクトリを残しました: ${work}`);
  log("完了");
}

main().catch((e) => {
  console.error(`\n[e2e] 失敗: ${(e as Error).message}\n作業ディレクトリ: ${work}`);
  if (existsSync(join(home, "agent-crew.db"))) console.error(`調査: AGENT_CREW_HOME=${home} npx agent-crew task show 1`);
  process.exitCode = 1;
});

