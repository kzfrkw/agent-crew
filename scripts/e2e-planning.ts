/**
 * 企画の流れの通し確認(フェーズ9a)。実機の claude(Web 検索を含む)を使うので利用枠を消費する。自動テストには含めない。
 *
 *   npm run e2e:planning
 *
 * 同梱の sample-web(小さな在庫 API)に対する新機能の企画を、調査 → 戦略 → 要件 → 構造・骨格 → 引き渡しまで進め、
 * 開発のタスクができて、1つ目が計画まで進むことを確かめる。
 *
 * 環境変数:
 *   E2E_MODEL  全役割のモデルを上書きする(既定 sonnet。"roles" なら roles/*.md の値をそのまま使う)
 *   E2E_KEEP   1 にすると、成功しても作業ディレクトリを残す
 *   E2E_FLOW   coordinator にすると、LLM のコーディネーターで進める(フェーズ10。既定は固定の流れ)。10-3 で同じ題材を両方の方式で比べる
 *
 * 人の回答待ちで止まったら、推奨案で進めるよう答えて続ける(回数は「人の介入」として記録する)
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDbPath } from "../src/app.ts";
import { openDb } from "../src/db/connection.ts";
import { getTask, listArtifacts, listChildren, listEvents } from "../src/db/store.ts";
import { taskDir } from "../src/orchestrator/paths.ts";
import type { TaskState } from "../src/orchestrator/states.ts";

const root = new URL("..", import.meta.url).pathname;
const bin = join(root, "bin/agent-crew.js");
const model = process.env.E2E_MODEL ?? "sonnet";
const flow = process.env.E2E_FLOW === "coordinator" ? "coordinator" : "fixed";
/** 人の回答待ちに答えた回数 */
let answers = 0;

// Claude Code のセッション内から実行すると TMPDIR が Claude の一時ディレクトリになり、サンドボックスが書き込みを拒否する。
// macOS では OS 本来の一時ディレクトリを使う
function baseTmp(): string {
  try {
    return execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim();
  } catch {
    return tmpdir();
  }
}

const work = join(baseTmp(), `agent-crew-e2e-planning-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const home = join(work, "home");
const repo = join(work, "sample-web");
const docs = join(work, "docs");
const started = Date.now();
const log = (msg: string) => console.log(`[e2e-planning ${Math.round((Date.now() - started) / 1000)}s] ${msg}`);
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "E2E Human", GIT_AUTHOR_EMAIL: "human@example.com", GIT_COMMITTER_NAME: "E2E Human", GIT_COMMITTER_EMAIL: "human@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
const cli = (...args: string[]) => {
  log(`agent-crew ${args.join(" ")}`);
  const out = execFileSync(process.execPath, [bin, ...args], { env: { ...process.env, AGENT_CREW_HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  process.stdout.write(out.replace(/^/gm, "    "));
  return out;
};

function withDb<T>(fn: (db: ReturnType<typeof openDb>) => T): T {
  const db = openDb(appDbPath(home));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const state = (id: number): TaskState => withDb((db) => getTask(db, id)!.state);

function report(id: number): { summary: string; ok: boolean } {
  return withDb((db) => {
    const rows = db
      .prepare("SELECT role, model, COUNT(*) AS n, ROUND(SUM(cost_usd), 3) AS cost, SUM(CAST((julianday(ended_at) - julianday(started_at)) * 86400 AS INTEGER)) AS sec FROM runs GROUP BY role, model ORDER BY MIN(id)")
      .all() as { role: string; model: string; n: number; cost: number; sec: number }[];
    const total = rows.reduce((a, r) => a + (r.cost ?? 0), 0);
    const kinds = new Set(listArtifacts(db, id).map((a) => a.kind));
    const dir = taskDir(home, id);
    const research = existsSync(join(dir, "research.md")) ? readFileSync(join(dir, "research.md"), "utf8") : "";
    const kids = listChildren(db, id);
    const events = listEvents(db, id, 5000);
    const critiques = events.filter((e) => e.kind === "critique").map((e) => e.payload as { stage: string; verdict: string });
    // 方式の比較の項目(設計メモ v0.22 の 3)
    const rubrics = events.filter((e) => e.kind === "rubric").map((e) => e.payload as { stage: string; attempt: number; mustFailed: string[] });
    const firstPass = ["research", "strategy", "scope", "ux", "handoff"].filter((s) => rubrics.find((r) => r.stage === s && r.attempt === 1)?.mustFailed.length === 0);
    const stops = events.filter((e) => e.kind === "needs_input").map((e) => (e.payload as { event?: string }).event ?? "?");
    const bounces = events.filter((e) => e.kind === "bounce").length;
    const moves = events.filter((e) => e.kind === "coordinator_move").map((e) => e.payload as { ok: boolean; deviatesFromDefault: boolean });
    const checks = [
      ...["research", "strategy", "strategy.slides", "scope", "scope.slides", "structure", "skeleton", "handoff"].map((k) => [`成果物 ${k}`, kinds.has(k)] as const),
      ["調査に Web の出典(URL)がある", /https?:\/\//.test(research)],
      ["調査担当が手元の資料を読んだ(資料の内容が調査に出てくる)", research.includes("棚卸し")],
      ["各段で批評が動いた", ["research", "strategy", "scope", "ux", "handoff"].every((s) => critiques.some((c) => c.stage === s))],
      ["開発のタスクができた(2つ以上、順番つき)", kids.length >= 2 && kids.every((k, i) => k.seq === i + 1)],
      ["企画は子の完了を待っている", getTask(db, id)!.state === "split"],
      ["1つ目の開発のタスクが計画まで進んだ", kids[0] ? getTask(db, kids[0].id)!.state === "awaiting_plan_approval" : false],
    ] as const;
    const lines = [
      `## ${new Date().toISOString()} 企画の流れ(${flow === "coordinator" ? "コーディネーター" : "固定の流れ"}、モデル: ${model})`,
      "",
      `- 止まった回数: ${stops.length}${stops.length ? `(${stops.join("、")})` : ""}、差し戻しの回数: ${bounces}、人の介入(回答): ${answers}`,
      `- ルーブリックの must の初回の合格: ${firstPass.length}/5 段(${firstPass.join("、") || "なし"})`,
      ...(flow === "coordinator" ? [`- コーディネーターの一手: ${moves.length}(却下 ${moves.filter((m) => !m.ok).length}、既定の進め方から外れた ${moves.filter((m) => m.ok && m.deviatesFromDefault).length})`] : []),
      `- 所要時間: ${Math.round((Date.now() - started) / 60000)}分`,
      `- 費用(見積もり)の合計: $${total.toFixed(3)}`,
      `- 批評: ${critiques.map((c) => `${c.stage}=${c.verdict}`).join("、")}`,
      `- 開発のタスク: ${kids.map((k) => `#${k.id} ${k.title}`).join(" / ")}`,
      "",
      "| 役割 | モデル | 回数 | 費用 | 秒 |",
      "|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.role} | ${r.model} | ${r.n} | $${r.cost ?? 0} | ${r.sec ?? 0} |`),
      "",
      ...checks.map(([name, ok]) => `- ${ok ? "✓" : "✗"} ${name}`),
      "",
    ];
    return { summary: lines.join("\n"), ok: checks.every(([, ok]) => ok) };
  });
}

async function main(): Promise<void> {
  log(`作業ディレクトリ: ${work}`);
  mkdirSync(home, { recursive: true });
  cpSync(join(root, "fixtures/sample-web"), repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, "要望メモ.md"), "# 店長からの要望\n\n- 月末の棚卸しのとき、在庫が少ないアイテムを一目で知りたい\n- 発注の目安になる数(しきい値)はアイテムごとに違う\n- 店長はスマホで見ることが多い\n");
  if (model !== "roles") {
    const names = ["profiler", "planner", "researcher", "strategist", "product", "ux", "handoff", "critic", "coordinator"];
    writeFileSync(join(home, "config.json"), JSON.stringify({ notify: false, roles: Object.fromEntries(names.map((r) => [r, { model }])) }, null, 2));
  }

  cli("project", "add", repo, "--name", "stock");
  const approved = cli("project", "approve", "stock", "--allow-without-tests");
  const infra = /整備タスクを作りました: #(\d+)/.exec(approved);
  if (infra) cli("task", "cancel", infra[1]!);
  const created = cli("task", "plan", "--project", "stock", "--title", "在庫が少ないアイテムを知らせる", "--body", "在庫 API に、在庫が少ないアイテムを知らせる機能を足したい。小さな店の店長が使う。", "--docs", docs, ...(flow === "coordinator" ? ["--coordinator"] : []));
  const id = Number(/#(\d+)/.exec(created)![1]);

  const expect = (s: TaskState) => {
    const actual = state(id);
    if (actual !== s) {
      cli("task", "show", String(id));
      throw new Error(`企画 #${id} が ${s} ではなく ${actual} です`);
    }
    log(`#${id}: ${actual} ✓`);
  };
  // 進める。人の回答待ちで止まったら、推奨案で進めるよう答える(3回まで)
  const run = () => {
    cli("run");
    for (let i = 0; i < 3 && state(id) === "needs_input"; i++) {
      cli("task", "show", String(id));
      cli("task", "answer", String(id), "--message", "推奨案で進めてください");
      answers++;
      cli("run");
    }
  };
  run();
  expect("awaiting_strategy_approval");
  // 批評担当の問い(方針の選択)には、承認のコメントで答える
  cli("task", "approve", String(id), "--kind", "strategy", "--comment", "スマホで見られる画面も作る。しきい値はアイテムごとに設定できるようにする。この方向で進めてください");
  run();
  expect("awaiting_scope_approval");
  cli("task", "approve", String(id), "--kind", "scope", "--comment", "問いがあれば推奨案で進めてください");
  run();
  expect("awaiting_handoff_approval");
  cli("task", "approve", String(id), "--kind", "handoff", "--comment", "推奨案で進めてください");
  // 1つ目の開発のタスクを計画まで進める
  cli("run");
  cli("task", "show", String(id));

  const { summary, ok } = report(id);
  console.log(`\n${summary}`);
  appendFileSync(join(root, "docs/e2e-log.md"), "\n" + summary + "\n");
  if (!ok) throw new Error("確認項目に失敗があります");
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
  else log(`作業ディレクトリを残しました: ${work}`);
  log("完了");
}

main().catch((e) => {
  console.error(`\n[e2e-planning] 失敗: ${(e as Error).message}\n作業ディレクトリ: ${work}`);
  process.exitCode = 1;
});
