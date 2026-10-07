import type { TaskState } from "../orchestrator/states.ts";
import type { Db } from "./connection.ts";

const now = () => new Date().toISOString();
type Row = Record<string, unknown>;

// ---- projects / repos ----

export type Project = {
  id: number;
  name: string;
  profileStatus: "none" | "draft" | "approved";
  testInfra: "unknown" | "present" | "insufficient" | "none";
  allowWithoutTests: boolean;
};

const toProject = (r: Row): Project => ({
  id: r.id as number,
  name: r.name as string,
  profileStatus: r.profile_status as Project["profileStatus"],
  testInfra: r.test_infra as Project["testInfra"],
  allowWithoutTests: r.allow_without_tests === 1,
});

export function createProject(db: Db, p: { name: string }): Project {
  const t = now();
  const { lastInsertRowid } = db
    .prepare("INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)")
    .run(p.name, t, t);
  return getProject(db, Number(lastInsertRowid))!;
}

export function getProject(db: Db, id: number): Project | undefined {
  const r = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
  return r && toProject(r);
}

export function getProjectByName(db: Db, name: string): Project | undefined {
  const r = db.prepare("SELECT * FROM projects WHERE name = ?").get(name) as Row | undefined;
  return r && toProject(r);
}

export function listProjects(db: Db): Project[] {
  return (db.prepare("SELECT * FROM projects ORDER BY id").all() as Row[]).map(toProject);
}

export function setProjectProfile(
  db: Db,
  id: number,
  u: { profileStatus?: Project["profileStatus"]; testInfra?: Project["testInfra"]; profile?: unknown },
): void {
  const cur = getProject(db, id);
  if (!cur) throw new Error(`プロジェクト ${id} がありません`);
  db.prepare("UPDATE projects SET profile_status = ?, test_infra = ?, profile_json = COALESCE(?, profile_json), updated_at = ? WHERE id = ?").run(
    u.profileStatus ?? cur.profileStatus,
    u.testInfra ?? cur.testInfra,
    u.profile === undefined ? null : JSON.stringify(u.profile),
    now(),
    id,
  );
}

export function setAllowWithoutTests(db: Db, id: number, allow: boolean): void {
  db.prepare("UPDATE projects SET allow_without_tests = ?, updated_at = ? WHERE id = ?").run(allow ? 1 : 0, now(), id);
}

export function getProjectProfile(db: Db, id: number): unknown {
  const r = db.prepare("SELECT profile_json FROM projects WHERE id = ?").get(id) as { profile_json: string | null } | undefined;
  return r?.profile_json ? JSON.parse(r.profile_json) : null;
}

export type Repo = { id: number; projectId: number; path: string; role: string; defaultBranch: string };

const toRepo = (r: Row): Repo => ({
  id: r.id as number,
  projectId: r.project_id as number,
  path: r.path as string,
  role: r.role as string,
  defaultBranch: r.default_branch as string,
});

export function addRepo(db: Db, r: Omit<Repo, "id">): Repo {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO repos (project_id, path, role, default_branch, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(r.projectId, r.path, r.role, r.defaultBranch, now());
  return { id: Number(lastInsertRowid), ...r };
}

export function getRepo(db: Db, id: number): Repo | undefined {
  const r = db.prepare("SELECT * FROM repos WHERE id = ?").get(id) as Row | undefined;
  return r && toRepo(r);
}

export function setRepoProfile(db: Db, id: number, profile: unknown): void {
  db.prepare("UPDATE repos SET profile_json = ? WHERE id = ?").run(JSON.stringify(profile), id);
}

export function getRepoProfile(db: Db, id: number): unknown {
  const r = db.prepare("SELECT profile_json FROM repos WHERE id = ?").get(id) as { profile_json: string | null } | undefined;
  return r?.profile_json ? JSON.parse(r.profile_json) : null;
}

export function listRepos(db: Db, projectId: number): Repo[] {
  return (db.prepare("SELECT * FROM repos WHERE project_id = ? ORDER BY id").all(projectId) as Row[]).map(toRepo);
}

// ---- tasks ----

export type Task = {
  id: number;
  projectId: number;
  title: string;
  body: string;
  sourceKind: "local" | "paste" | "notion";
  sourceUrl: string | null;
  kind: "normal" | "test_infra";
  state: TaskState;
  heldFromState: TaskState | null;
  assignee: "agent" | "human" | null;
  reviewRounds: number;
  createdAt: string;
  updatedAt: string;
};

const toTask = (r: Row): Task => ({
  id: r.id as number,
  projectId: r.project_id as number,
  title: r.title as string,
  body: r.body as string,
  sourceKind: r.source_kind as Task["sourceKind"],
  sourceUrl: (r.source_url as string | null) ?? null,
  kind: r.kind as Task["kind"],
  state: r.state as TaskState,
  heldFromState: (r.held_from_state as TaskState | null) ?? null,
  assignee: (r.assignee as Task["assignee"]) ?? null,
  reviewRounds: r.review_rounds as number,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

export function createTask(
  db: Db,
  t: { projectId: number; title: string; body: string; sourceKind?: Task["sourceKind"]; sourceUrl?: string; kind?: Task["kind"] },
): Task {
  const ts = now();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO tasks (project_id, title, body, source_kind, source_url, kind, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(t.projectId, t.title, t.body, t.sourceKind ?? "local", t.sourceUrl ?? null, t.kind ?? "normal", ts, ts);
  return getTask(db, Number(lastInsertRowid))!;
}

export function getTask(db: Db, id: number): Task | undefined {
  const r = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
  return r && toTask(r);
}

export function listTasks(db: Db, filter: { projectId?: number } = {}): Task[] {
  const rows =
    filter.projectId === undefined
      ? db.prepare("SELECT * FROM tasks ORDER BY id").all()
      : db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY id").all(filter.projectId);
  return (rows as Row[]).map(toTask);
}

/** 状態を書き換える。遷移が正しいかの判断は src/orchestrator が行う */
export function updateTaskState(
  db: Db,
  id: number,
  u: { state: TaskState; heldFromState?: TaskState | null; assignee?: Task["assignee"]; reviewRounds?: number },
): void {
  const cur = getTask(db, id);
  if (!cur) throw new Error(`タスク ${id} がありません`);
  db.prepare("UPDATE tasks SET state = ?, held_from_state = ?, assignee = ?, review_rounds = ?, updated_at = ? WHERE id = ?").run(
    u.state,
    u.heldFromState === undefined ? cur.heldFromState : u.heldFromState,
    u.assignee === undefined ? cur.assignee : u.assignee,
    u.reviewRounds ?? cur.reviewRounds,
    now(),
    id,
  );
}

export type TaskRepo = { taskId: number; repoId: number; worktreePath: string; branchName: string; baseSha: string };

export function attachRepoToTask(db: Db, tr: TaskRepo): void {
  db.prepare(
    "INSERT INTO task_repos (task_id, repo_id, worktree_path, branch_name, base_sha, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(tr.taskId, tr.repoId, tr.worktreePath, tr.branchName, tr.baseSha, now());
}

export function listTaskRepos(db: Db, taskId: number): TaskRepo[] {
  return (db.prepare("SELECT * FROM task_repos WHERE task_id = ? ORDER BY repo_id").all(taskId) as Row[]).map((r) => ({
    taskId: r.task_id as number,
    repoId: r.repo_id as number,
    worktreePath: r.worktree_path as string,
    branchName: r.branch_name as string,
    baseSha: r.base_sha as string,
  }));
}

// ---- runs / events / artifacts ----

export type RunState = "running" | "succeeded" | "failed" | "timeout" | "cancelled";
export type Run = { id: number; taskId: number | null; projectId: number | null; role: string; model: string | null; state: RunState };

export function startRun(db: Db, r: { taskId?: number; projectId?: number; role: string; model?: string }): Run {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO runs (task_id, project_id, role, model, state, started_at) VALUES (?, ?, ?, ?, 'running', ?)")
    .run(r.taskId ?? null, r.projectId ?? null, r.role, r.model ?? null, now());
  return {
    id: Number(lastInsertRowid),
    taskId: r.taskId ?? null,
    projectId: r.projectId ?? null,
    role: r.role,
    model: r.model ?? null,
    state: "running",
  };
}

export function finishRun(
  db: Db,
  id: number,
  r: { state: Exclude<RunState, "running">; verdict?: string; summary?: string; sessionId?: string; costUsd?: number; structuredOutput?: unknown; error?: string },
): void {
  db.prepare(
    `UPDATE runs SET state = ?, verdict = ?, summary = ?, session_id = ?, cost_usd = ?, structured_output = ?, error = ?, ended_at = ?
     WHERE id = ?`,
  ).run(
    r.state,
    r.verdict ?? null,
    r.summary ?? null,
    r.sessionId ?? null,
    r.costUsd ?? null,
    r.structuredOutput === undefined ? null : JSON.stringify(r.structuredOutput),
    r.error ?? null,
    now(),
    id,
  );
}

export type Event = { id: number; taskId: number | null; runId: number | null; kind: string; payload: unknown; createdAt: string };

export function addEvent(db: Db, e: { taskId?: number; runId?: number; kind: string; payload: unknown }): void {
  db.prepare("INSERT INTO events (task_id, run_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(
    e.taskId ?? null,
    e.runId ?? null,
    e.kind,
    JSON.stringify(e.payload),
    now(),
  );
}

export function listEvents(db: Db, taskId: number, limit = 200): Event[] {
  const rows = db
    .prepare("SELECT * FROM (SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id")
    .all(taskId, limit) as Row[];
  return rows.map((r) => ({
    id: r.id as number,
    taskId: (r.task_id as number | null) ?? null,
    runId: (r.run_id as number | null) ?? null,
    kind: r.kind as string,
    payload: JSON.parse(r.payload as string),
    createdAt: r.created_at as string,
  }));
}

export type Artifact = { id: number; taskId: number | null; runId: number | null; kind: string; path: string; verdict: string | null };

export function addArtifact(db: Db, a: { taskId?: number; runId?: number; kind: string; path: string; verdict?: string }): void {
  db.prepare("INSERT INTO artifacts (task_id, run_id, kind, path, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    a.taskId ?? null,
    a.runId ?? null,
    a.kind,
    a.path,
    a.verdict ?? null,
    now(),
  );
}

export function listArtifacts(db: Db, taskId: number): Artifact[] {
  return (db.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY id").all(taskId) as Row[]).map((r) => ({
    id: r.id as number,
    taskId: (r.task_id as number | null) ?? null,
    runId: (r.run_id as number | null) ?? null,
    kind: r.kind as string,
    path: r.path as string,
    verdict: (r.verdict as string | null) ?? null,
  }));
}

// ---- approvals ----

/** tests はオーケストレーターによるテストの再実行の結果 */
export type ApprovalKind = "plan" | "design" | "final" | "review" | "qa" | "tests";
export type Approval = {
  id: number;
  taskId: number;
  repoId: number | null;
  kind: ApprovalKind;
  result: "approved" | "rejected";
  commitSha: string | null;
  comment: string | null;
};

export function addApproval(
  db: Db,
  a: { taskId: number; repoId?: number; kind: ApprovalKind; result: Approval["result"]; commitSha?: string; comment?: string },
): void {
  db.prepare(
    "INSERT INTO approvals (task_id, repo_id, kind, result, commit_sha, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(a.taskId, a.repoId ?? null, a.kind, a.result, a.commitSha ?? null, a.comment ?? null, now());
}

/** 失効していない承認(人の変更やコミットの追加で失効したものを除く) */
export function listValidApprovals(db: Db, taskId: number): Approval[] {
  const rows = db.prepare("SELECT * FROM approvals WHERE task_id = ? AND invalidated_at IS NULL ORDER BY id").all(taskId) as Row[];
  return rows.map((r) => ({
    id: r.id as number,
    taskId: r.task_id as number,
    repoId: (r.repo_id as number | null) ?? null,
    kind: r.kind as ApprovalKind,
    result: r.result as Approval["result"],
    commitSha: (r.commit_sha as string | null) ?? null,
    comment: (r.comment as string | null) ?? null,
  }));
}

export function invalidateApprovals(db: Db, taskId: number, kinds: ApprovalKind[]): void {
  const stmt = db.prepare("UPDATE approvals SET invalidated_at = ? WHERE task_id = ? AND kind = ? AND invalidated_at IS NULL");
  const t = now();
  for (const k of kinds) stmt.run(t, taskId, k);
}
