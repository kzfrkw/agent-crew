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
import { approvedProject, newTask, PROFILE } from "./helpers/project.ts";
import { answer, ScriptedRunner, writeArtifact } from "./helpers/scripted-runner.ts";

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

describe("企画用のプロジェクトを作る(GUI から。フェーズ9)", () => {
  it("名前だけで作り、作ったプロジェクトを返す。名前の誤りや重複は 400", async () => {
    const { ctx } = await setup();
    const r = await post("/api/projects", { name: "kakeibo" });
    expect(r.status).toBe(201);
    expect(r.body.project).toMatchObject({ name: "kakeibo" });
    const { getProjectByName, listRepos } = await import("../src/db/store.ts");
    const p = getProjectByName(ctx.db, "kakeibo")!;
    expect(listRepos(ctx.db, p.id)).toEqual([]);
    expect((await post("/api/projects", { name: "kakeibo" })).status).toBe(400);
    expect((await post("/api/projects", { name: "家計簿" })).status).toBe(400);
    expect((await post("/api/projects", { name: "" })).status).toBe(400);
  });
});

describe("引き渡しで開発のプロジェクトを作り、GUI からプロファイルを承認する(フェーズ9)", () => {
  const profiler = (spec: RunSpec) => {
    writeArtifact(spec, "profile.md", "ready");
    return { structuredOutput: { verdict: "ready", summary: "s", profile: { ...PROFILE, testInfra: "none" } } };
  };

  /** 企画用のプロジェクトの、引き渡しの承認待ちのタスク */
  async function handoffWaiting(ctx: Awaited<ReturnType<typeof setup>>["ctx"]) {
    const { createPlanningProject, createPlanningTask } = await import("../src/orchestrator/planning.ts");
    const { addEvent } = await import("../src/db/store.ts");
    createPlanningProject(ctx, "newsvc");
    const t = createPlanningTask(ctx, { projectName: "newsvc", title: "新サービス", body: "b", docs: [] });
    updateTaskState(ctx.db, t.id, { state: "awaiting_handoff_approval" });
    addEvent(ctx.db, { taskId: t.id, kind: "handoff", payload: { tickets: [{ title: "最初の画面", body: "b", acceptanceCriteria: ["a"] }] } });
    return t;
  }

  it("リポジトリのフォルダと名前を送ると、プロジェクトを作って開発のタスクを作り、裏でプロファイルを作る。できたら承認でき、テスト基盤を待たずに始めることもできる", async () => {
    const { ctx } = await setup({ profiler });
    const t = await handoffWaiting(ctx);
    const dir = join(tempDir("agent-crew-new-"), "app");
    const r = await post(`/api/tasks/${t.id}/actions`, { action: "approve", kind: "handoff", devProject: { repoPath: dir, name: "newsvc-dev" } });
    expect(r.status).toBe(200);
    expect(r.body.message).toContain("プロファイル");
    const { getProjectByName, listChildren } = await import("../src/db/store.ts");
    const dev = getProjectByName(ctx.db, "newsvc-dev")!;
    expect(listChildren(ctx.db, t.id).map((k) => k.projectId)).toEqual([dev.id]);
    await waitFor(() => getProjectByName(ctx.db, "newsvc-dev")!.profileStatus === "draft");
    const a = await post(`/api/projects/${dev.id}/profile`, { action: "approve", allowWithoutTests: true });
    expect(a.status).toBe(200);
    expect(getProjectByName(ctx.db, "newsvc-dev")).toMatchObject({ profileStatus: "approved", allowWithoutTests: true });
    expect(listTasks(ctx.db, { projectId: dev.id }).some((x) => x.kind === "test_infra")).toBe(true);
  });

  it("使えないフォルダは 409 で、何も作らない。プロファイルの作り直しも受け付ける", async () => {
    const { ctx } = await setup({ profiler });
    const t = await handoffWaiting(ctx);
    const r = await post(`/api/tasks/${t.id}/actions`, { action: "approve", kind: "handoff", devProject: { repoPath: "relative" } });
    expect(r.status).toBe(409);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_handoff_approval");
    expect((await post(`/api/tasks/${t.id}/actions`, { action: "approve", kind: "handoff", devProject: { name: "x" } })).status).toBe(400);
    const { getProjectByName } = await import("../src/db/store.ts");
    const own = getProjectByName(ctx.db, "newsvc")!;
    // リポジトリが無ければ作り直せない
    expect((await post(`/api/projects/${own.id}/profile`, { action: "reprofile" })).status).toBe(409);
    expect((await post(`/api/projects/${own.id}/profile`, { action: "approve" })).status).toBe(409);
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

  it("企画のタスク(9a)も作れる。読ませる資料は絶対パスで、無ければ 400", async () => {
    const { ctx, project } = await setup();
    const docs = (await import("./helpers/gitrepo.ts")).tempDir("agent-crew-docs-");
    const r = await post("/api/tasks", { projectId: project.id, title: "新機能の企画", body: "b", kind: "planning", docs: [docs] });
    expect(r.status).toBe(201);
    expect(getTask(ctx.db, (r.body.task as TaskSummary).id)).toMatchObject({ kind: "planning" });
    expect((await post("/api/tasks", { projectId: project.id, title: "x", body: "", kind: "planning", docs: ["relative/path"] })).status).toBe(400);
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

  it("計画の承認で、設計の段で動かす役割を上書きできる", async () => {
    const { ctx, project } = await setup();
    const t = newTask(ctx, project.id);
    updateTaskState(ctx.db, t.id, { state: "awaiting_plan_approval" });
    const r = await post(`/api/tasks/${t.id}/actions`, { action: "approve", kind: "plan", design: { architect: false, designer: true } });
    expect(r.status).toBe(200);
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "designing", design: { architect: false, designer: true } });
    updateTaskState(ctx.db, t.id, { state: "awaiting_plan_approval" });
    expect((await post(`/api/tasks/${t.id}/actions`, { action: "approve", kind: "plan", design: { architect: "yes" } })).status).toBe(400);
  });

  it("デザイン仕様の承認", async () => {
    const { ctx, project } = await setup();
    const t = newTask(ctx, project.id);
    updateTaskState(ctx.db, t.id, { state: "awaiting_design_approval" });
    expect((await post(`/api/tasks/${t.id}/actions`, { action: "approve", kind: "design" })).body.task.state).toBe("implementing");
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

describe("プロジェクトの設定(GUI から。v0.23)", () => {
  it("取り込み方・計画の自動承認・振り返り・企画のコーディネーターを切り替え、詳細に今の値と操作できるかを出す", async () => {
    const { ctx, project } = await setup({}, { worker: true });
    const { getProjectSettings } = await import("../src/db/store.ts");
    const before = await call("GET", `/api/projects/${project.id}`);
    expect(before.body.settings).toEqual({ integrate: "pr", autoApprovePlan: false, retrospective: true, coordinator: false, explain: true, workspace: "worktree" });
    expect(before.body.operable).toBe(true);
    const r = await post(`/api/projects/${project.id}/settings`, { integrate: "main", coordinator: true });
    expect(r.status).toBe(200);
    expect(r.body.settings).toEqual({ integrate: "main", autoApprovePlan: false, retrospective: true, coordinator: true, explain: true, workspace: "worktree" });
    expect((await post(`/api/projects/${project.id}/settings`, { explain: false })).body.settings.explain).toBe(false);
    expect((await post(`/api/projects/${project.id}/settings`, { workspace: "repo" })).body.settings.workspace).toBe("repo");
    expect((await post(`/api/projects/${project.id}/settings`, { workspace: "clone" })).status).toBe(400);
    expect(getProjectSettings(ctx.db, project.id)).toMatchObject({ integrate: "main", coordinator: true });
    // 書いていない項目は変えない
    await post(`/api/projects/${project.id}/settings`, { retrospective: false });
    expect(getProjectSettings(ctx.db, project.id)).toMatchObject({ integrate: "main", coordinator: true, retrospective: false });
  });

  it("不正な値や知らない項目は拒否し、何も変えない", async () => {
    const { ctx, project } = await setup();
    const { getProjectSettings } = await import("../src/db/store.ts");
    expect((await post(`/api/projects/${project.id}/settings`, { integrate: "rebase" })).status).toBe(400);
    expect((await post(`/api/projects/${project.id}/settings`, { coordinator: "yes" })).status).toBe(400);
    expect((await post(`/api/projects/${project.id}/settings`, { integrate: "main", push: true })).status).toBe(400);
    expect((await post(`/api/projects/999/settings`, { integrate: "main" })).status).toBe(404);
    expect(getProjectSettings(ctx.db, project.id)).toEqual({});
  });
});

describe("用語集(v0.24)", () => {
  it("プロジェクトの詳細に用語集を出す。ファイルの先頭の見出しは除く(画面の節に見出しがあるため)", async () => {
    const { ctx, project } = await setup();
    const { appendGlossary, glossaryPath } = await import("../src/orchestrator/glossary.ts");
    expect((await call("GET", `/api/projects/${project.id}`)).body.glossaryMd).toBeNull();
    appendGlossary(glossaryPath(ctx.home, project.id), [{ term: "ページング", explanation: "一覧を分けて返すこと" }], "#1");
    const md = (await call("GET", `/api/projects/${project.id}`)).body.glossaryMd as string;
    expect(md).toContain("**ページング**");
    expect(md).not.toMatch(/^# /);
  });
});
