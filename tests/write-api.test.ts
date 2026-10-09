import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appDbPath } from "../src/app.ts";
import { openDb } from "../src/db/connection.ts";
import { getTask, listTasks, startRun, updateTaskState } from "../src/db/store.ts";
import { humanNotesPath } from "../src/orchestrator/human.ts";
import { Worker } from "../src/orchestrator/worker.ts";
import type { ActionResult, Overview, TaskSummary } from "../src/server/api-types.ts";
import { startServer, type RunningServer } from "../src/server/server.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { testContext } from "./helpers/context.ts";
import { tempDir } from "./helpers/gitrepo.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner } from "./helpers/scripted-runner.ts";

let server: RunningServer | undefined;
let worker: Worker | undefined;
afterEach(async () => {
  await worker?.close();
  await server?.close();
  server = worker = undefined;
});

const plannerReady = answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false, design: { architect: false, designer: false, reason: "小さな変更" } });
const untilAborted = (spec: RunSpec) =>
  new Promise<{ status: "cancelled"; error: string }>((resolve) => spec.signal!.addEventListener("abort", () => resolve({ status: "cancelled", error: "停止" })));

/** 書き込みのできるサーバー(DB はデータディレクトリのファイル。読み取り API と同じものを見る) */
async function setup(scripts: ConstructorParameters<typeof ScriptedRunner>[0] = {}, o: { worker?: boolean; editor?: string } = {}) {
  const ctx = testContext(new ScriptedRunner(scripts), o.editor ? { editor: o.editor } : {});
  ctx.db = openDb(appDbPath(ctx.home));
  const { project } = await approvedProject(ctx);
  if (o.worker) {
    worker = new Worker(ctx, { pollMs: 50 });
    worker.start();
  }
  server = await startServer({ home: ctx.home, port: 0, ops: { ctx, worker } });
  return { ctx, project };
}

type Res = { status: number; body: any };
function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const url = new URL(path, server!.url);
  const h: Record<string, string> = {
    "content-type": "application/json",
    "x-agent-crew": "1",
    origin: `http://127.0.0.1:${server!.port}`,
    ...headers,
  };
  for (const [k, v] of Object.entries(h)) if (v === "") delete h[k];
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: h }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode!, body: text.startsWith("{") ? JSON.parse(text) : text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}
const post = (path: string, body: unknown, headers?: Record<string, string>) => call("POST", path, body, headers);

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error("待ちきれませんでした");
}

describe("書き込み API: 安全策", () => {
  it("専用ヘッダーが無い・Origin が違う・JSON でない要求は拒否する(外部のサイトからの操作を防ぐ)", async () => {
    const { ctx, project } = await setup();
    const t = newTask(ctx, project.id);
    const action = `/api/tasks/${t.id}/actions`;
    expect((await post(action, { action: "cancel" }, { "x-agent-crew": "" })).status).toBe(403);
    expect((await post(action, { action: "cancel" }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await post(action, { action: "cancel" }, { origin: "" })).status).toBe(403);
    expect((await post(action, "action=cancel", { "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await post(action, "{壊れた")).status).toBe(400);
    expect(getTask(ctx.db, t.id)!.state).toBe("queued");
  });

  it("ops なしで起動したら(--no-worker の読み取り専用)書き込みは 405", async () => {
    const home = tempDir("agent-crew-ro-");
    server = await startServer({ home, port: 0 });
    expect((await post("/api/tasks", { projectId: 1, title: "x", body: "" })).status).toBe(405);
  });
});

describe("チケット投入", () => {
  it("作ったタスクを返す。取り込み元の URL があれば貼り付けとして記録する", async () => {
    const { ctx, project } = await setup();
    const r = await post("/api/tasks", { projectId: project.id, title: " 検索を追加 ", body: "本文", sourceUrl: "https://www.notion.so/x" });
    expect(r.status).toBe(201);
    const task = r.body.task as TaskSummary;
    expect(task).toMatchObject({ title: "検索を追加", state: "queued" });
    expect(getTask(ctx.db, task.id)).toMatchObject({ body: "本文", sourceKind: "paste", sourceUrl: "https://www.notion.so/x" });
  });

  it("入力の誤りは 400(タイトルが空、プロジェクトが無い、URL が http(s) でない)", async () => {
    const { ctx, project } = await setup();
    expect((await post("/api/tasks", { projectId: project.id, title: "  ", body: "" })).status).toBe(400);
    expect((await post("/api/tasks", { projectId: 999, title: "x", body: "" })).status).toBe(400);
    expect((await post("/api/tasks", { projectId: project.id, title: "x", body: "", sourceUrl: "javascript:alert(1)" })).status).toBe(400);
    expect(listTasks(ctx.db)).toHaveLength(0);
  });

  it("常駐ワーカーがいれば、作ったらすぐ計画に入る", async () => {
    const { ctx, project } = await setup({ planner: plannerReady }, { worker: true });
    const r = await post("/api/tasks", { projectId: project.id, title: "x", body: "" });
    await waitFor(() => getTask(ctx.db, r.body.task.id)!.state === "awaiting_plan_approval");
  });
});

describe("人の操作", () => {
  it("承認(コメントは人のメモに残る)。結果のタスクの要約を返す", async () => {
    const { ctx, project } = await setup();
    const t = newTask(ctx, project.id);
    updateTaskState(ctx.db, t.id, { state: "awaiting_plan_approval" });
    const r = await post(`/api/tasks/${t.id}/actions`, { action: "approve", kind: "plan", comment: "これで進めて" });
    expect(r.status).toBe(200);
    expect((r.body as ActionResult).task.state).toBe("implementing");
    expect(readFileSync(humanNotesPath(ctx.home, t.id), "utf8")).toContain("これで進めて");
  });

  it("却下の理由・回答が空なら 400", async () => {
    const { ctx, project } = await setup();
    const t = newTask(ctx, project.id);
    updateTaskState(ctx.db, t.id, { state: "awaiting_plan_approval" });
    expect((await post(`/api/tasks/${t.id}/actions`, { action: "reject", kind: "plan", comment: " " })).status).toBe(400);
    updateTaskState(ctx.db, t.id, { state: "needs_input", heldFromState: "planning" });
    expect((await post(`/api/tasks/${t.id}/actions`, { action: "answer", message: "" })).status).toBe(400);
  });

  it("その状態で受け付けない操作は 409 と理由", async () => {
    const { ctx, project } = await setup();
    const t = newTask(ctx, project.id);
    const r = await post(`/api/tasks/${t.id}/actions`, { action: "approve", kind: "plan" });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("承認待ちではありません");
  });

  it("知らない操作は 400、無いタスクは 404", async () => {
    const { ctx, project } = await setup();
    const t = newTask(ctx, project.id);
    expect((await post(`/api/tasks/${t.id}/actions`, { action: "explode" })).status).toBe(400);
    expect((await post("/api/tasks/999/actions", { action: "cancel" })).status).toBe(404);
  });

  it("停止: 常駐ワーカーが動かしている実行を止め、人の判断待ちにする", async () => {
    const { ctx, project } = await setup({ planner: untilAborted }, { worker: true });
    const t = newTask(ctx, project.id);
    worker!.kick();
    await waitFor(() => worker!.status().active.includes(t.id) && getTask(ctx.db, t.id)!.state === "planning");
    const r = await post(`/api/tasks/${t.id}/actions`, { action: "stop" });
    expect(r.status).toBe(200);
    await waitFor(() => getTask(ctx.db, t.id)!.state === "needs_input");
  });

  it("停止: このサーバーが動かしていない実行(CLI の run)は 409", async () => {
    const { ctx, project } = await setup();
    const t = newTask(ctx, project.id);
    updateTaskState(ctx.db, t.id, { state: "planning" });
    startRun(ctx.db, { taskId: t.id, role: "planner" });
    const r = await post(`/api/tasks/${t.id}/actions`, { action: "stop" });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("Ctrl-C");
  });

  it("エディタで開く: 設定のエディタに worktree のパスだけを渡す", async () => {
    const dir = tempDir("agent-crew-editor-");
    const editor = join(dir, "fake-editor.sh");
    const out = join(dir, "args.txt");
    writeFileSync(editor, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}'\n`);
    chmodSync(editor, 0o755);
    const { ctx, project } = await setup({ planner: plannerReady }, { editor });
    const t = newTask(ctx, project.id);
    const { runUntilIdle } = await import("../src/orchestrator/engine.ts");
    await runUntilIdle(ctx); // worktree を作る
    updateTaskState(ctx.db, t.id, { state: "human_working", heldFromState: "implementing" });
    const r = await post(`/api/tasks/${t.id}/actions`, { action: "open_editor" });
    expect(r.status).toBe(200);
    await waitFor(() => existsSync(out));
    const { listTaskRepos } = await import("../src/db/store.ts");
    expect(readFileSync(out, "utf8").trim()).toBe(listTaskRepos(ctx.db, t.id)[0]!.worktreePath);
  });
});

describe("自動実行の切り替え", () => {
  it("一時停止・再開。状態は overview の worker に出る", async () => {
    await setup({}, { worker: true });
    const overview = async () => ((await call("GET", "/api/overview")).body as Overview).worker;
    expect((await overview()).state).toBe("running");
    expect((await post("/api/worker", { paused: true })).status).toBe(200);
    expect((await overview()).state).toBe("paused");
    expect((await post("/api/worker", { paused: false })).status).toBe(200);
    expect((await overview()).state).toBe("running");
  });

  it("ワーカーなしなら worker は disabled、切り替えは 409", async () => {
    await setup();
    expect(((await call("GET", "/api/overview")).body as Overview).worker.state).toBe("disabled");
    expect((await post("/api/worker", { paused: true })).status).toBe(409);
  });
});
