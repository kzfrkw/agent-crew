import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, SCHEMA_VERSION } from "../src/db/connection.ts";
import {
  addApproval,
  addArtifact,
  addEvent,
  addRepo,
  attachRepoToTask,
  createProject,
  createTask,
  finishRun,
  getProjectByName,
  getTask,
  invalidateApprovals,
  listArtifacts,
  listEvents,
  listRepos,
  listTaskRepos,
  listTasks,
  listValidApprovals,
  startRun,
  updateTaskState,
} from "../src/db/store.ts";

const fresh = () => openDb(":memory:");

function seed() {
  const db = fresh();
  const project = createProject(db, { name: "shop" });
  const backend = addRepo(db, { projectId: project.id, path: "/repos/shop-api", role: "backend", defaultBranch: "main" });
  const frontend = addRepo(db, { projectId: project.id, path: "/repos/shop-web", role: "frontend", defaultBranch: "main" });
  const task = createTask(db, { projectId: project.id, title: "注文履歴を表示する", body: "本文" });
  return { db, project, backend, frontend, task };
}

describe("接続とマイグレーション", () => {
  it("スキーマの版が設定され、2回開いても壊れない", () => {
    const path = join(mkdtempSync(join(tmpdir(), "agent-crew-db-")), "agent-crew.db");
    const db1 = openDb(path);
    createProject(db1, { name: "p" });
    db1.close();
    const db2 = openDb(path);
    expect(db2.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(getProjectByName(db2, "p")?.name).toBe("p");
    db2.close();
  });

  it("外部キーが有効", () => {
    const db = fresh();
    expect(() => addRepo(db, { projectId: 999, path: "/x", role: "main", defaultBranch: "main" })).toThrow();
  });
});

describe("プロジェクトとリポジトリ", () => {
  it("1プロジェクトに複数のリポジトリを登録できる", () => {
    const { db, project } = seed();
    expect(listRepos(db, project.id).map((r) => r.role)).toEqual(["backend", "frontend"]);
  });

  it("同じパスのリポジトリは二重登録できない", () => {
    const { db, project } = seed();
    expect(() => addRepo(db, { projectId: project.id, path: "/repos/shop-api", role: "x", defaultBranch: "main" })).toThrow();
  });

  it("プロジェクト名は一意", () => {
    const { db } = seed();
    expect(() => createProject(db, { name: "shop" })).toThrow();
  });
});

describe("タスク", () => {
  it("作成直後は queued で、種別は normal、差し戻し回数は0", () => {
    const { task } = seed();
    expect(task).toMatchObject({ state: "queued", kind: "normal", reviewRounds: 0, sourceKind: "local", assignee: null });
  });

  it("1タスクを複数リポジトリのworktreeに紐づけられる(task_repos)", () => {
    const { db, task, backend, frontend } = seed();
    attachRepoToTask(db, { taskId: task.id, repoId: backend.id, worktreePath: "/wt/1/backend", branchName: "agent-crew/1-x", baseSha: "aaa" });
    attachRepoToTask(db, { taskId: task.id, repoId: frontend.id, worktreePath: "/wt/1/frontend", branchName: "agent-crew/1-x", baseSha: "bbb" });
    const trs = listTaskRepos(db, task.id);
    expect(trs).toHaveLength(2);
    expect(new Set(trs.map((t) => t.branchName))).toEqual(new Set(["agent-crew/1-x"]));
  });

  it("状態を更新でき、保留前の状態を記録できる", () => {
    const { db, task } = seed();
    updateTaskState(db, task.id, { state: "planning" });
    updateTaskState(db, task.id, { state: "needs_input", heldFromState: "planning" });
    expect(getTask(db, task.id)).toMatchObject({ state: "needs_input", heldFromState: "planning" });
    updateTaskState(db, task.id, { state: "planning", heldFromState: null, assignee: "agent" });
    expect(getTask(db, task.id)).toMatchObject({ state: "planning", heldFromState: null, assignee: "agent" });
  });

  it("プロジェクトで絞り込んで一覧できる", () => {
    const { db, project } = seed();
    const other = createProject(db, { name: "other" });
    createTask(db, { projectId: other.id, title: "t", body: "" });
    expect(listTasks(db, { projectId: project.id })).toHaveLength(1);
    expect(listTasks(db)).toHaveLength(2);
  });
});

describe("実行・イベント・成果物", () => {
  it("実行を開始・終了し、判定と費用を記録する", () => {
    const { db, task } = seed();
    const run = startRun(db, { taskId: task.id, role: "planner", model: "opus" });
    expect(run.state).toBe("running");
    finishRun(db, run.id, { state: "succeeded", verdict: "ready", summary: "計画を作成", sessionId: "s-1", costUsd: 0.12, structuredOutput: { verdict: "ready" } });
    const events = listEvents(db, task.id);
    expect(events).toEqual([]);
    addEvent(db, { taskId: task.id, runId: run.id, kind: "tool_use", payload: { name: "Read" } });
    addEvent(db, { taskId: task.id, kind: "state_changed", payload: { to: "planning" } });
    expect(listEvents(db, task.id).map((e) => e.kind)).toEqual(["tool_use", "state_changed"]);
    expect(listEvents(db, task.id)[0]?.payload).toEqual({ name: "Read" });
    const row = db.prepare("SELECT verdict, cost_usd, session_id FROM runs WHERE id = ?").get(run.id);
    expect(row).toEqual({ verdict: "ready", cost_usd: 0.12, session_id: "s-1" });
  });

  it("成果物を登録して一覧できる", () => {
    const { db, task } = seed();
    addArtifact(db, { taskId: task.id, kind: "plan", path: "/data/tasks/1/plan.md", verdict: "ready" });
    expect(listArtifacts(db, task.id)).toMatchObject([{ kind: "plan", verdict: "ready" }]);
  });
});

describe("承認", () => {
  it("コミットに紐づく承認を失効できる", () => {
    const { db, task, backend } = seed();
    addApproval(db, { taskId: task.id, kind: "plan", result: "approved" });
    addApproval(db, { taskId: task.id, repoId: backend.id, kind: "review", result: "approved", commitSha: "abc" });
    addApproval(db, { taskId: task.id, repoId: backend.id, kind: "qa", result: "approved", commitSha: "abc" });
    expect(listValidApprovals(db, task.id).map((a) => a.kind)).toEqual(["plan", "review", "qa"]);
    invalidateApprovals(db, task.id, ["review", "qa"]);
    expect(listValidApprovals(db, task.id).map((a) => a.kind)).toEqual(["plan"]);
  });
});
