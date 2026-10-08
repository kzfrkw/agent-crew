import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
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

/** GUI のビルド結果の代わり */
function fakeGui(): string {
  const root = tempDir("agent-crew-gui-");
  const dir = join(root, "gui");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), '<!doctype html><div id="root"></div><script type="module" src="/assets/app.js"></script>');
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(root, "secret.txt"), "secret");
  return dir;
}

function get(url: string, method = "GET"): Promise<{ status: number; body: string; type?: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode!, body, type: res.headers["content-type"], headers: res.headers }));
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

  it("GUI: ビルド結果を配信し、画面の URL には index.html を返す(SPA)。CSP を付ける", async () => {
    const { home } = seed();
    const guiDir = fakeGui();
    server = await startServer({ home, port: 0, guiDir });
    for (const path of ["", "tasks/1", "runs/3", "projects/1"]) {
      const r = await get(`${server.url}${path}`);
      expect(r.status).toBe(200);
      expect(r.type).toContain("text/html");
      expect(r.body).toContain('<div id="root">');
      expect(r.headers["content-security-policy"]).toContain("default-src 'self'");
    }
    const js = await get(`${server.url}assets/app.js`);
    expect(js.type).toContain("text/javascript");
    expect(js.body).toContain("console.log");
    expect((await get(`${server.url}assets/nope.js`)).status).toBe(404);
    expect((await get(`${server.url}assets/%2e%2e/%2e%2e/secret.txt`)).status).not.toBe(200);
  });

  it("GUI がビルドされていなければ、ビルドの方法を案内する", async () => {
    const { home } = seed();
    server = await startServer({ home, port: 0, guiDir: join(tempDir("agent-crew-nogui-"), "none") });
    const r = await get(server.url);
    expect(r.status).toBe(503);
    expect(r.body).toContain("npm run build:gui");
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
