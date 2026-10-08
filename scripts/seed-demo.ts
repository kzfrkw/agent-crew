/**
 * GUI の開発・確認用の見本データを作る(実機の claude は使わない)。
 *   AGENT_CREW_HOME=/tmp/demo node scripts/seed-demo.ts && AGENT_CREW_HOME=/tmp/demo npx agent-crew serve
 * 既存のデータディレクトリには書かない(DB があれば中止する)。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDbPath } from "../src/app.ts";
import { openDb } from "../src/db/connection.ts";
import {
  addApproval,
  addArtifact,
  addEvent,
  addRepo,
  attachRepoToTask,
  createProject,
  createTask,
  finishRun,
  invalidateApprovals,
  setProjectProfile,
  startRun,
  updateTaskState,
} from "../src/db/store.ts";
import { projectDir, runDir, taskDir } from "../src/orchestrator/paths.ts";

const home = process.env.AGENT_CREW_HOME;
if (!home) throw new Error("AGENT_CREW_HOME を指定してください(見本データを書く場所)");
if (existsSync(appDbPath(home))) throw new Error(`${appDbPath(home)} がすでにあります。空のディレクトリを指定してください`);

const db = openDb(appDbPath(home));

const p = createProject(db, { name: "sample-shop" });
setProjectProfile(db, p.id, { profileStatus: "approved", testInfra: "present", profile: { build: "npm run build", test: "npm test" } });
const repo = addRepo(db, { projectId: p.id, path: "/Users/me/dev/sample-shop", role: "main", defaultBranch: "main" });
mkdirSync(projectDir(home, p.id), { recursive: true });
writeFileSync(
  join(projectDir(home, p.id), "profile.md"),
  "---\nverdict: ready\n---\n# プロジェクトプロファイル\n\n## ビルド・テスト\n\n| 種類 | コマンド |\n|---|---|\n| ビルド | `npm run build` |\n| テスト | `npm test`(vitest) |\n\n## 構成\n\n- `src/server.ts`: HTTP サーバー\n- `src/items.ts`: 在庫の一覧\n",
);
writeFileSync(join(projectDir(home, p.id), "decisions.md"), "# 設計判断ログ\n\n- 2026-10-08: 在庫の一覧APIは、在庫0を既定で除外する(`?all=1` で含める)\n");
const pr = startRun(db, { projectId: p.id, role: "profiler", model: "sonnet" });
finishRun(db, pr.id, { state: "succeeded", verdict: "ready", summary: "Node 製の小さな HTTP アプリ。vitest のテストあり", costUsd: 0.068 });

const p2 = createProject(db, { name: "notes-app" });
setProjectProfile(db, p2.id, { profileStatus: "draft", testInfra: "insufficient" });
addRepo(db, { projectId: p2.id, path: "/Users/me/dev/notes-app", role: "main", defaultBranch: "main" });

function artifact(taskId: number, runId: number, file: string, text: string, verdict: string) {
  mkdirSync(taskDir(home!, taskId), { recursive: true });
  mkdirSync(runDir(home!, runId), { recursive: true });
  writeFileSync(join(taskDir(home!, taskId), file), text);
  writeFileSync(join(runDir(home!, runId), file), text);
  addArtifact(db, { taskId, runId, kind: file.replace(/\.md$/, ""), path: join(taskDir(home!, taskId), file), verdict });
}

function run(taskId: number, role: string, verdict: string, summary: string, cost: number, events: [string, unknown][] = []) {
  const r = startRun(db, { taskId, role, model: role === "verifier" ? "haiku" : "sonnet" });
  addEvent(db, { taskId, runId: r.id, kind: "init", payload: { model: "claude-sonnet-5-5", tools: ["Read", "Edit", "Bash"] } });
  for (const [kind, payload] of events) addEvent(db, { taskId, runId: r.id, kind, payload });
  mkdirSync(runDir(home!, r.id), { recursive: true });
  writeFileSync(join(runDir(home!, r.id), "stream.jsonl"), '{"type":"system","subtype":"init"}\n');
  return { id: r.id, finish: () => finishRun(db, r.id, { state: "succeeded", verdict, summary, costUsd: cost }) };
}

function state(taskId: number, from: string, to: string, extra: object = {}) {
  addEvent(db, { taskId, kind: "state_changed", payload: { from, to, ...extra } });
}

// 1. 計画の承認待ち
const t1 = createTask(db, { projectId: p.id, title: "在庫0のアイテムを一覧APIから除外する", body: "GET /items で在庫0のものを返さないでほしい。\n管理画面からは全件見たいので、オプションで含められるように。" });
attachRepoToTask(db, { taskId: t1.id, repoId: repo.id, worktreePath: "/Users/me/.agent-team/worktrees/sample-shop/1-exclude-zero/main", branchName: "agent-crew/1-exclude-zero", baseSha: "a1b2c3d" });
state(t1.id, "queued", "planning");
const r1 = run(t1.id, "planner", "ready", "クエリ ?all=1 で全件を返す方針。テストを先に追加する", 0.091, [
  ["assistant_text", { text: "まず既存の一覧APIとテストを確認します。" }],
  ["tool_use", { name: "Read", input: { file_path: "src/items.ts" } }],
  ["tool_result", { isError: false, content: "export function listItems() { ... }" }],
  ["tool_use", { name: "Bash", input: { command: "npm test -- --reporter=dot" } }],
  ["tool_result", { isError: false, content: "Test Files  3 passed (3)" }],
  ["assistant_text", { text: "方針がまとまったので plan.md を書きます。" }],
  ["tool_use", { name: "Write", input: { file_path: "plan.md" } }],
  ["result", { subtype: "success", isError: false, costUsd: 0.091, numTurns: 7 }],
]);
artifact(
  t1.id,
  r1.id,
  "plan.md",
  "---\nverdict: ready\nsummary: クエリ ?all=1 で全件を返す\n---\n# 計画\n\n## 方針\n\n- `listItems()` に `includeEmpty` を追加し、既定は在庫0を除外する\n- `GET /items?all=1` で全件を返す\n\n## テスト(先に書く)\n\n1. 在庫0のアイテムが既定で返らない\n2. `?all=1` なら返る\n\n## 影響範囲\n\n| ファイル | 変更 |\n|---|---|\n| `src/items.ts` | 引数の追加 |\n| `src/server.ts` | クエリの解釈 |\n",
  "ready",
);
r1.finish();
updateTaskState(db, t1.id, { state: "awaiting_plan_approval" });
state(t1.id, "planning", "awaiting_plan_approval");

// 2. 回答待ち
const t2 = createTask(db, { projectId: p.id, title: "商品検索を追加する", body: "名前で部分一致検索できるようにしたい" });
state(t2.id, "queued", "planning");
const r2 = run(t2.id, "planner", "need_human", "検索の仕様に不明点がある", 0.05, [["assistant_text", { text: "仕様に不明点があるので、人に確認します。" }]]);
r2.finish();
updateTaskState(db, t2.id, { state: "needs_input", heldFromState: "planning" });
state(t2.id, "planning", "needs_input", { reason: "planner の判定: need_human" });
addEvent(db, { taskId: t2.id, kind: "needs_input", payload: { reason: "検索は大文字・小文字を区別しますか? また、ひらがなとカタカナを同一視しますか?" } });

// 3. 実行中(レビュー)
const t3 = createTask(db, { projectId: p.id, title: "一覧APIのページングを追加する", body: "limit と offset を受け付ける" });
attachRepoToTask(db, { taskId: t3.id, repoId: repo.id, worktreePath: "/Users/me/.agent-team/worktrees/sample-shop/3-paging/main", branchName: "agent-crew/3-paging", baseSha: "a1b2c3d" });
state(t3.id, "queued", "planning");
const r3a = run(t3.id, "planner", "ready", "limit/offset を追加", 0.08);
artifact(t3.id, r3a.id, "plan.md", "---\nverdict: ready\n---\n# 計画\n\nlimit と offset を追加する。\n", "ready");
r3a.finish();
state(t3.id, "planning", "awaiting_plan_approval");
addApproval(db, { taskId: t3.id, kind: "plan", result: "approved" });
state(t3.id, "awaiting_plan_approval", "implementing");
const r3b = run(t3.id, "implementer", "done", "ページングを実装し、テストを追加した", 0.093, [
  ["tool_use", { name: "Edit", input: { file_path: "src/items.test.ts" } }],
  ["tool_use", { name: "Bash", input: { command: "npm test" } }],
  ["tool_result", { isError: true, content: "1 failed: limit を受け付ける" }],
  ["tool_use", { name: "Edit", input: { file_path: "src/items.ts" } }],
  ["tool_use", { name: "Bash", input: { command: "npm test" } }],
  ["tool_result", { isError: false, content: "Tests  12 passed (12)" }],
]);
artifact(t3.id, r3b.id, "impl-notes.md", "---\nverdict: done\n---\n# 実装メモ\n\n- `limit` の上限は 100\n", "done");
r3b.finish();
addEvent(db, { taskId: t3.id, runId: r3b.id, kind: "implemented", payload: { commits: [{ sha: "d4e5f6a", subject: "一覧APIにページングを追加" }] } });
addApproval(db, { taskId: t3.id, kind: "tests", result: "approved", commitSha: "d4e5f6a" });
updateTaskState(db, t3.id, { state: "reviewing", assignee: "agent" });
state(t3.id, "implementing", "reviewing");
const r3c = startRun(db, { taskId: t3.id, role: "reviewer", model: "sonnet" });
addEvent(db, { taskId: t3.id, runId: r3c.id, kind: "init", payload: { model: "claude-sonnet-5-5", tools: ["Read", "Grep", "Bash"] } });
addEvent(db, { taskId: t3.id, runId: r3c.id, kind: "assistant_text", payload: { text: "差分とテストの変更を確認します。" } });
addEvent(db, { taskId: t3.id, runId: r3c.id, kind: "tool_use", payload: { name: "Bash", input: { command: "git diff main...HEAD -- src/items.test.ts" } } });

// 4. 人が作業中
const t4 = createTask(db, { projectId: p.id, title: "README に API の説明を書く", body: "" });
state(t4.id, "queued", "implementing");
updateTaskState(db, t4.id, { state: "human_working", heldFromState: "implementing", assignee: "human" });
addEvent(db, { taskId: t4.id, kind: "human_takeover", payload: { heads: {} } });
addApproval(db, { taskId: t4.id, kind: "review", result: "approved", commitSha: "0011223" });
invalidateApprovals(db, t4.id, ["review"]);

// 5. 失敗
const t5 = createTask(db, { projectId: p.id, title: "依存パッケージを更新する", body: "" });
updateTaskState(db, t5.id, { state: "failed", heldFromState: "qa" });
const r5 = startRun(db, { taskId: t5.id, role: "qa", model: "sonnet" });
finishRun(db, r5.id, { state: "timeout", error: "時間の上限(600秒)を超えました" });
addEvent(db, { taskId: t5.id, runId: r5.id, kind: "run_failed", payload: { role: "qa", failure: "limit", reason: "時間の上限(600秒)を超えました" } });
addEvent(db, { taskId: t5.id, kind: "failed", payload: { reason: "QA が時間の上限を超えました" } });

// 6. 完了
const t6 = createTask(db, { projectId: p.id, title: "ヘルスチェックのエンドポイントを追加", body: "" });
updateTaskState(db, t6.id, { state: "done" });
addEvent(db, { taskId: t6.id, kind: "integrated", payload: { repo: "/Users/me/dev/sample-shop", branch: "agent-crew/6-health", head: "9f8e7d6" } });

// 7. テスト基盤整備(下書きプロジェクト)
createTask(db, { projectId: p2.id, title: "テスト基盤を整備する", body: "", kind: "test_infra" });

db.close();
console.log(`見本データを作りました: ${home}`);
