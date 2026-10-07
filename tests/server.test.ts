import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appDbPath } from "../src/app.ts";
import { openDb } from "../src/db/connection.ts";
import { addArtifact, addEvent, addRepo, createProject, createTask, startRun, updateTaskState } from "../src/db/store.ts";
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
  addRepo(db, { projectId: p.id, path: "/r/shop", role: "main", defaultBranch: "main" });
  const t1 = createTask(db, { projectId: p.id, title: "在庫0を除外 <script>alert(1)</script>", body: "" });
  updateTaskState(db, t1.id, { state: "needs_input", heldFromState: "planning" });
  addEvent(db, { taskId: t1.id, kind: "needs_input", payload: { reason: "planner の判定: need_human" } });
  const t2 = createTask(db, { projectId: p.id, title: "検索を追加", body: "" });
  updateTaskState(db, t2.id, { state: "implementing", assignee: "agent" });
  startRun(db, { taskId: t2.id, role: "implementer", model: "sonnet" });
  mkdirSync(join(home, "tasks", String(t1.id)), { recursive: true });
  const plan = join(home, "tasks", String(t1.id), "plan.md");
  writeFileSync(plan, "---\nverdict: ready\n---\n# 計画\n");
  addArtifact(db, { taskId: t1.id, kind: "plan", path: plan, verdict: "ready" });
  writeFileSync(join(home, "config.json"), JSON.stringify({ secret: "x" }));
  db.close();
  return { home, t1, t2 };
}

function get(url: string, method = "GET"): Promise<{ status: number; body: string; type?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode!, body, type: res.headers["content-type"] }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("agent-crew serve", () => {
  it("127.0.0.1 だけで待ち受ける", async () => {
    const { home } = seed();
    server = await startServer({ home, port: 0 });
    expect(server.address).toBe("127.0.0.1");
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it("一覧: タスクと状態を表示し、人の対応が必要なものを目立たせる。値はエスケープする", async () => {
    const { home } = seed();
    server = await startServer({ home, port: 0 });
    const r = await get(server.url);
    expect(r.status).toBe(200);
    expect(r.type).toContain("text/html");
    expect(r.body).toContain("shop");
    expect(r.body).toContain("人の回答待ち");
    expect(r.body).toMatch(/class="[^"]*attention/);
    expect(r.body).toContain("&lt;script&gt;");
    expect(r.body).not.toContain("<script>alert(1)");
    expect(r.body).toContain("implementer"); // 実行中の役割
    expect(r.body).toContain('http-equiv="refresh"');
  });

  it("詳細: 理由、成果物へのリンク、実行中の警告", async () => {
    const { home, t1, t2 } = seed();
    server = await startServer({ home, port: 0 });
    const d1 = await get(`${server.url}tasks/${t1.id}`);
    expect(d1.body).toContain("planner の判定: need_human");
    expect(d1.body).toContain(`/files/tasks/${t1.id}/plan.md`);
    const d2 = await get(`${server.url}tasks/${t2.id}`);
    expect(d2.body).toContain("触らないでください");
  });

  it("成果物を配信する", async () => {
    const { home, t1 } = seed();
    server = await startServer({ home, port: 0 });
    const r = await get(`${server.url}files/tasks/${t1.id}/plan.md`);
    expect(r.status).toBe(200);
    expect(r.body).toContain("# 計画");
  });

  it("GET 以外は 405", async () => {
    const { home } = seed();
    server = await startServer({ home, port: 0 });
    for (const m of ["POST", "PUT", "DELETE"]) expect((await get(server.url, m)).status).toBe(405);
  });

  it.each([
    "files/../config.json",
    "files/%2e%2e/config.json",
    "files/tasks/%2e%2e/%2e%2e/config.json",
    "files/agent-crew.db",
    "files/config.json",
    "files/tasks/1/../../agent-crew.db",
  ])("データディレクトリの外や、DB・設定は配信しない: %s", async (path) => {
    const { home } = seed();
    server = await startServer({ home, port: 0 });
    const r = await get(`${server.url}${path}`);
    expect([400, 403, 404]).toContain(r.status);
    expect(r.body).not.toContain("secret");
  });

  it("シンボリックリンクで外に出るファイルは配信しない", async () => {
    const { home, t1 } = seed();
    const outside = join(tempDir("agent-crew-outside-"), "secret.txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(home, "tasks", String(t1.id), "leak.txt"));
    server = await startServer({ home, port: 0 });
    const r = await get(`${server.url}files/tasks/${t1.id}/leak.txt`);
    expect(r.status).toBe(403);
  });
});
