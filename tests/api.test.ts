import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import type { ArtifactDetail, EventsPage, Overview, ProjectDetail, RunDetail, TaskDetail } from "../src/server/api-types.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";
import { tempDir } from "./helpers/gitrepo.ts";

let server: RunningServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function seed() {
  const home = tempDir("agent-crew-home-");
  const db = openDb(appDbPath(home));
  const p = createProject(db, { name: "shop" });
  setProjectProfile(db, p.id, { profile: { build: "npm run build" }, profileStatus: "approved", testInfra: "present" });
  const repo = addRepo(db, { projectId: p.id, path: "/r/shop", role: "main", defaultBranch: "main" });
  mkdirSync(join(home, "projects", String(p.id)), { recursive: true });
  writeFileSync(join(home, "projects", String(p.id), "decisions.md"), "# 設計判断ログ\n- A を採用\n");
  writeFileSync(join(home, "projects", String(p.id), "profile.md"), "---\nverdict: ready\n---\n# プロファイル\n");
  const profiler = startRun(db, { projectId: p.id, role: "profiler", model: "sonnet" });
  finishRun(db, profiler.id, { state: "succeeded", verdict: "ready", costUsd: 0.05 });

  // t1: 計画の承認待ち。plan.md あり
  const t1 = createTask(db, { projectId: p.id, title: "在庫0を除外", body: "本文です" });
  attachRepoToTask(db, { taskId: t1.id, repoId: repo.id, worktreePath: "/wt/1", branchName: "ac/1-x", baseSha: "abc" });
  const r1 = startRun(db, { taskId: t1.id, role: "planner", model: "sonnet" });
  addEvent(db, { taskId: t1.id, runId: r1.id, kind: "assistant_text", payload: { text: "計画を書きます" } });
  const tdir = join(home, "tasks", String(t1.id));
  const rdir = join(home, "runs", String(r1.id));
  mkdirSync(tdir, { recursive: true });
  mkdirSync(rdir, { recursive: true });
  writeFileSync(join(tdir, "plan.md"), "---\nverdict: ready\n---\n# 計画(最新)\n");
  writeFileSync(join(rdir, "plan.md"), "---\nverdict: ready\nsummary: 要約\n---\n# 計画\n| a | b |\n|---|---|\n");
  writeFileSync(join(rdir, "stream.jsonl"), "{}\n");
  addArtifact(db, { taskId: t1.id, runId: r1.id, kind: "plan", path: join(tdir, "plan.md"), verdict: "ready" });
  finishRun(db, r1.id, { state: "succeeded", verdict: "ready", summary: "計画しました", costUsd: 0.09 });
  updateTaskState(db, t1.id, { state: "awaiting_plan_approval" });
  addApproval(db, { taskId: t1.id, kind: "review", result: "approved", commitSha: "c1" });
  invalidateApprovals(db, t1.id, ["review"]);

  // t2: 回答待ち
  const t2 = createTask(db, { projectId: p.id, title: "検索を追加", body: "" });
  updateTaskState(db, t2.id, { state: "needs_input", heldFromState: "planning" });
  addEvent(db, { taskId: t2.id, kind: "needs_input", payload: { reason: "APIの形はAとBどちら?" } });

  // t3: 実行中
  const t3 = createTask(db, { projectId: p.id, title: "一覧を速く", body: "" });
  updateTaskState(db, t3.id, { state: "implementing", assignee: "agent" });
  const r3 = startRun(db, { taskId: t3.id, role: "implementer", model: "sonnet" });
  addEvent(db, { taskId: t3.id, runId: r3.id, kind: "tool_use", payload: { name: "Bash", input: { command: "npm test" } } });

  // t4: 取り消し
  const t4 = createTask(db, { projectId: p.id, title: "やめた", body: "" });
  updateTaskState(db, t4.id, { state: "cancelled" });

  db.close();
  return { home, p, t1, t2, t3, t4, r1, r3, profiler };
}

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode!, body, type: res.headers["content-type"] }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function json<T>(path: string): Promise<T> {
  const r = await get(`${server!.url}${path}`);
  expect(r.status, r.body).toBe(200);
  expect(r.type).toContain("application/json");
  return JSON.parse(r.body) as T;
}

describe("読み取り API", () => {
  it("overview: プロジェクト、タスクの要約(対応待ちの種類と理由、実行中の役割)、実行中の実行", async () => {
    const s = seed();
    server = await startServer({ home: s.home, port: 0 });
    const o = await json<Overview>("api/overview");
    expect(o.projects).toEqual([expect.objectContaining({ name: "shop", profileStatus: "approved", testInfra: "present" })]);
    const byId = new Map(o.tasks.map((t) => [t.id, t]));
    expect(byId.get(s.t1.id)).toMatchObject({ attention: "approve_plan", stateLabel: "計画の承認待ち", running: null });
    expect(byId.get(s.t2.id)).toMatchObject({
      attention: "answer",
      reason: "APIの形はAとBどちら?",
      primaryAction: { kind: "answer", command: `agent-crew task answer ${s.t2.id} --message "..."` },
    });
    expect(byId.get(s.t3.id)).toMatchObject({ attention: null, primaryAction: null, running: { id: s.r3.id, role: "implementer", model: "sonnet" } });
    expect(byId.get(s.t4.id)?.state).toBe("cancelled");
    expect(o.running).toEqual([expect.objectContaining({ id: s.r3.id, taskTitle: "一覧を速く" })]);
    expect(o.stateLabels.needs_input).toBe("人の回答待ち");
  });

  it("task: worktree、承認(失効も)、成果物、実行、合計、次の操作", async () => {
    const s = seed();
    server = await startServer({ home: s.home, port: 0 });
    const d = await json<TaskDetail>(`api/tasks/${s.t1.id}`);
    expect(d.task).toMatchObject({ title: "在庫0を除外", body: "本文です", attention: "approve_plan" });
    expect(d.project.name).toBe("shop");
    expect(d.worktrees).toEqual([{ repoRole: "main", worktreePath: "/wt/1", branchName: "ac/1-x", baseSha: "abc" }]);
    expect(d.approvals).toEqual([expect.objectContaining({ kind: "review", result: "approved", invalidatedAt: expect.any(String) })]);
    expect(d.artifacts).toEqual([
      expect.objectContaining({ kind: "plan", fileName: "plan.md", verdict: "ready", url: `/files/runs/${s.r1.id}/plan.md` }),
    ]);
    expect(d.runs).toEqual([expect.objectContaining({ id: s.r1.id, role: "planner", state: "succeeded", summary: "計画しました" })]);
    expect(d.totals.costUsd).toBeCloseTo(0.09);
    expect(d.nextActions[0]).toMatchObject({ kind: "approve", command: `agent-crew task approve ${s.t1.id} --kind plan` });
    expect(d.runActive).toBe(false);
  });

  it("artifact: 実行時点の写しを返し、Markdown の frontmatter を分ける", async () => {
    const s = seed();
    server = await startServer({ home: s.home, port: 0 });
    const d = await json<TaskDetail>(`api/tasks/${s.t1.id}`);
    const a = await json<ArtifactDetail>(`api/artifacts/${d.artifacts[0]!.id}`);
    expect(a.mediaType).toBe("markdown");
    expect(a.frontmatter).toEqual({ verdict: "ready", summary: "要約" });
    expect(a.content).toBe("# 計画\n| a | b |\n|---|---|\n");
    expect(a.task).toMatchObject({ id: s.t1.id });
    expect(a.run?.role).toBe("planner");
    expect(a.siblings).toHaveLength(1);
  });

  it("run: メタ情報と生ログの URL", async () => {
    const s = seed();
    server = await startServer({ home: s.home, port: 0 });
    const r = await json<RunDetail>(`api/runs/${s.r1.id}`);
    expect(r.run).toMatchObject({ role: "planner", verdict: "ready", costUsd: 0.09 });
    expect(r.run.durationSec).toEqual(expect.any(Number));
    expect(r.task).toEqual({ id: s.t1.id, title: "在庫0を除外" });
    expect(r.streamUrl).toBe(`/files/runs/${s.r1.id}/stream.jsonl`);
    expect(r.artifacts).toHaveLength(1);
  });

  it("project: プロファイル、decisions.md、プロジェクト把握担当の実行、タスク", async () => {
    const s = seed();
    server = await startServer({ home: s.home, port: 0 });
    const p = await json<ProjectDetail>(`api/projects/${s.p.id}`);
    expect(p.profile).toEqual({ build: "npm run build" });
    expect(p.decisionsMd).toContain("A を採用");
    expect(p.profileMd).toBe("# プロファイル\n"); // frontmatter は除く
    expect(p.repos).toEqual([expect.objectContaining({ path: "/r/shop", role: "main" })]);
    expect(p.runs).toEqual([expect.objectContaining({ id: s.profiler.id, role: "profiler" })]);
    expect(p.tasks).toHaveLength(4);
  });

  it("events: after 以降を id 昇順で。タスク・実行で絞れる", async () => {
    const s = seed();
    server = await startServer({ home: s.home, port: 0 });
    const all = await json<EventsPage>("api/events");
    expect(all.events.map((e) => e.id)).toEqual([...all.events.map((e) => e.id)].sort((a, b) => a - b));
    expect(all.lastId).toBe(all.events.at(-1)!.id);
    const after = await json<EventsPage>(`api/events?after=${all.events[0]!.id}`);
    expect(after.events).toHaveLength(all.events.length - 1);
    const byTask = await json<EventsPage>(`api/events?task=${s.t2.id}`);
    expect(byTask.events.map((e) => e.kind)).toEqual(["needs_input"]);
    const byRun = await json<EventsPage>(`api/events?run=${s.r3.id}`);
    expect(byRun.events).toEqual([expect.objectContaining({ kind: "tool_use", taskId: s.t3.id })]);
    const latest = await json<EventsPage>("api/events?limit=1");
    expect(latest.events).toEqual([expect.objectContaining({ id: all.lastId })]);
  });

  it("存在しないものは 404、不正な値は 400", async () => {
    const s = seed();
    server = await startServer({ home: s.home, port: 0 });
    expect((await get(`${server.url}api/tasks/999`)).status).toBe(404);
    expect((await get(`${server.url}api/runs/999`)).status).toBe(404);
    expect((await get(`${server.url}api/nope`)).status).toBe(404);
    expect((await get(`${server.url}api/events?after=x`)).status).toBe(400);
  });

  it("DB がまだ無ければ空の overview", async () => {
    server = await startServer({ home: tempDir("agent-crew-empty-"), port: 0 });
    const o = await json<Overview>("api/overview");
    expect(o.projects).toEqual([]);
    expect(o.tasks).toEqual([]);
  });

  it("Host ヘッダーが 127.0.0.1 / localhost 以外なら拒否する(DNS リバインディング対策)", async () => {
    const s = seed();
    server = await startServer({ home: s.home, port: 0 });
    expect((await get(`${server.url}api/overview`, { host: "evil.example" })).status).toBe(403);
    expect((await get(`${server.url}api/overview`, { host: `localhost:${server.port}` })).status).toBe(200);
  });
});
