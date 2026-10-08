import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse as parseYaml } from "yaml";
import { appDbPath } from "../app.ts";
import type { Db } from "../db/connection.ts";
import {
  getArtifact,
  getProject,
  getProjectProfile,
  getRun,
  getTask,
  listAllApprovals,
  listArtifacts,
  listProjects,
  listRepos,
  listRunArtifacts,
  listRuns,
  listTaskRepos,
  listTasks,
  queryEvents,
  type Artifact,
  type Project,
  type RunRow,
  type Task,
} from "../db/store.ts";
import { latestReason, runActive } from "../orchestrator/engine.ts";
import { attentionOf, nextActions } from "../orchestrator/next-actions.ts";
import { projectDir, runDir } from "../orchestrator/paths.ts";
import { STATE_LABELS } from "../orchestrator/states.ts";
import type {
  ArtifactDetail,
  ArtifactSummary,
  EventsPage,
  Overview,
  ProjectDetail,
  ProjectSummary,
  RunDetail,
  RunSummary,
  TaskDetail,
  TaskSummary,
} from "./api-types.ts";
import { fileUrl } from "./files.ts";

/**
 * 読み取り専用の JSON API(docs/structure.md)。DB は要求ごとに読み取り専用で開く
 * (書き込みは別プロセスの agent-crew run が行う)。
 */

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export function openReadOnly(home: string): Db | undefined {
  const path = appDbPath(home);
  return existsSync(path) ? new DatabaseSync(path, { readOnly: true }) : undefined;
}

/** /api/ 以下の要求に答える。見つからなければ HttpError を投げる */
export function handleApi(home: string, path: string, query: URLSearchParams): unknown {
  const db = openReadOnly(home);
  if (!db) {
    if (path === "overview") return emptyOverview();
    if (path === "events") return { events: [], lastId: 0 } satisfies EventsPage;
    throw new HttpError(404, "まだデータがありません");
  }
  try {
    if (path === "overview") return overview(db);
    if (path === "events") return events(db, query);
    const m = /^(tasks|runs|artifacts|projects)\/(\d+)$/.exec(path);
    if (m) {
      const id = Number(m[2]);
      const found =
        m[1] === "tasks" ? taskDetail(home, db, id) : m[1] === "runs" ? runDetail(home, db, id) : m[1] === "artifacts" ? artifactDetail(home, db, id) : projectDetail(home, db, id);
      if (!found) throw new HttpError(404, "ありません");
      return found;
    }
    throw new HttpError(404, "ありません");
  } finally {
    db.close();
  }
}

// ---- 変換 ----

const projectSummary = (p: Project): ProjectSummary => ({
  id: p.id,
  name: p.name,
  profileStatus: p.profileStatus,
  testInfra: p.testInfra,
  allowWithoutTests: p.allowWithoutTests,
});

function runSummary(r: RunRow): RunSummary {
  return {
    id: r.id,
    taskId: r.taskId,
    projectId: r.projectId,
    role: r.role,
    model: r.model,
    state: r.state,
    verdict: r.verdict,
    summary: r.summary,
    error: r.error,
    costUsd: r.costUsd,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationSec: r.endedAt ? Math.max(0, Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000)) : null,
  };
}

function taskSummary(db: Db, t: Task, running: Map<number, RunRow>): TaskSummary {
  const attention = attentionOf(t);
  const r = running.get(t.id);
  return {
    id: t.id,
    projectId: t.projectId,
    title: t.title,
    kind: t.kind,
    state: t.state,
    stateLabel: STATE_LABELS[t.state],
    heldFromState: t.heldFromState,
    assignee: t.assignee,
    reviewRounds: t.reviewRounds,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    attention,
    reason: attention === "answer" || attention === "failed" ? (latestReason(db, t.id, t.state as "needs_input" | "failed") ?? null) : null,
    running: r ? { id: r.id, role: r.role, model: r.model, startedAt: r.startedAt } : null,
  };
}

function runningByTask(db: Db): Map<number, RunRow> {
  const m = new Map<number, RunRow>();
  for (const r of listRuns(db, { state: "running" })) if (r.taskId !== null) m.set(r.taskId, r);
  return m;
}

/** 成果物の実行時点の写し(runs/<id>/<ファイル名>)。無ければ最新の置き場所 */
function artifactFile(home: string, a: Artifact): string {
  if (a.runId !== null) {
    const copy = join(runDir(home, a.runId), basename(a.path));
    if (existsSync(copy)) return copy;
  }
  return a.path;
}

const artifactSummary = (home: string, a: Artifact): ArtifactSummary => ({
  id: a.id,
  taskId: a.taskId,
  runId: a.runId,
  kind: a.kind,
  fileName: basename(a.path),
  verdict: a.verdict,
  createdAt: a.createdAt,
  url: fileUrl(home, artifactFile(home, a)),
});

function readText(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size > MAX_TEXT_BYTES) return null;
  return readFileSync(path, "utf8");
}

function mediaTypeOf(path: string): ArtifactDetail["mediaType"] {
  const ext = extname(path).toLowerCase();
  if (ext === ".md") return "markdown";
  if ([".txt", ".log", ".patch", ".diff", ".json", ".jsonl"].includes(ext)) return "text";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
  return "other";
}

/** 先頭の frontmatter(--- で囲んだ YAML)を本文から分ける */
export function splitFrontmatter(text: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: null, body: text };
  try {
    const fm = parseYaml(m[1]!);
    if (fm && typeof fm === "object" && !Array.isArray(fm)) return { frontmatter: fm as Record<string, unknown>, body: text.slice(m[0].length) };
  } catch {
    // 壊れた frontmatter はそのまま本文として見せる
  }
  return { frontmatter: null, body: text };
}

// ---- 各 API ----

function emptyOverview(): Overview {
  return { projects: [], tasks: [], running: [], stateLabels: STATE_LABELS };
}

function overview(db: Db): Overview {
  const running = runningByTask(db);
  const tasks = listTasks(db);
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  return {
    projects: listProjects(db).map(projectSummary),
    tasks: tasks.map((t) => taskSummary(db, t, running)),
    running: listRuns(db, { state: "running" }).map((r) => ({ ...runSummary(r), taskTitle: r.taskId === null ? null : (titles.get(r.taskId) ?? null) })),
    stateLabels: STATE_LABELS,
  };
}

function taskDetail(home: string, db: Db, id: number): TaskDetail | undefined {
  const t = getTask(db, id);
  if (!t) return undefined;
  const runs = listRuns(db, { taskId: id }).map(runSummary);
  const roles = new Map(listRepos(db, t.projectId).map((r) => [r.id, r.role]));
  return {
    task: { ...taskSummary(db, t, runningByTask(db)), body: t.body, sourceKind: t.sourceKind, sourceUrl: t.sourceUrl },
    project: projectSummary(getProject(db, t.projectId)!),
    worktrees: listTaskRepos(db, id).map((tr) => ({
      repoRole: roles.get(tr.repoId) ?? "",
      worktreePath: tr.worktreePath,
      branchName: tr.branchName,
      baseSha: tr.baseSha,
    })),
    approvals: listAllApprovals(db, id).map((a) => ({
      id: a.id,
      kind: a.kind,
      result: a.result,
      commitSha: a.commitSha,
      comment: a.comment,
      createdAt: a.createdAt,
      invalidatedAt: a.invalidatedAt,
    })),
    artifacts: listArtifacts(db, id).map((a) => artifactSummary(home, a)),
    runs,
    totals: {
      costUsd: runs.reduce((s, r) => s + (r.costUsd ?? 0), 0),
      durationSec: runs.reduce((s, r) => s + (r.durationSec ?? 0), 0),
    },
    nextActions: nextActions(db, t),
    runActive: runActive(db, id),
  };
}

function artifactDetail(home: string, db: Db, id: number): ArtifactDetail | undefined {
  const a = getArtifact(db, id);
  if (!a) return undefined;
  const file = artifactFile(home, a);
  const mediaType = mediaTypeOf(file);
  const text = mediaType === "markdown" || mediaType === "text" ? readText(file) : null;
  const split = mediaType === "markdown" && text !== null ? splitFrontmatter(text) : { frontmatter: null, body: text };
  const task = a.taskId === null ? undefined : getTask(db, a.taskId);
  const run = a.runId === null ? undefined : getRun(db, a.runId);
  return {
    artifact: artifactSummary(home, a),
    task: task ? { id: task.id, title: task.title, projectId: task.projectId } : null,
    run: run ? runSummary(run) : null,
    siblings: task ? listArtifacts(db, task.id).map((x) => artifactSummary(home, x)) : [],
    mediaType,
    content: split.body,
    frontmatter: split.frontmatter,
  };
}

function runDetail(home: string, db: Db, id: number): RunDetail | undefined {
  const r = getRun(db, id);
  if (!r) return undefined;
  const task = r.taskId === null ? undefined : getTask(db, r.taskId);
  const projectId = task?.projectId ?? r.projectId;
  const project = projectId === null ? undefined : getProject(db, projectId);
  return {
    run: runSummary(r),
    task: task ? { id: task.id, title: task.title } : null,
    project: project ? projectSummary(project) : null,
    artifacts: listRunArtifacts(db, id).map((a) => artifactSummary(home, a)),
    streamUrl: fileUrl(home, join(runDir(home, id), "stream.jsonl")),
  };
}

function projectDetail(home: string, db: Db, id: number): ProjectDetail | undefined {
  const p = getProject(db, id);
  if (!p) return undefined;
  const running = runningByTask(db);
  return {
    project: projectSummary(p),
    repos: listRepos(db, id).map((r) => ({ id: r.id, path: r.path, role: r.role, defaultBranch: r.defaultBranch })),
    profile: getProjectProfile(db, id),
    profileMd: readText(join(projectDir(home, id), "profile.md")),
    decisionsMd: readText(join(projectDir(home, id), "decisions.md")),
    runs: listRuns(db, { projectId: id }).filter((r) => r.taskId === null).map(runSummary),
    tasks: listTasks(db, { projectId: id }).map((t) => taskSummary(db, t, running)),
  };
}

function intParam(q: URLSearchParams, name: string): number | undefined {
  const v = q.get(name);
  if (v === null || v === "") return undefined;
  if (!/^\d+$/.test(v)) throw new HttpError(400, `${name} は 0 以上の整数で指定してください`);
  return Number(v);
}

function events(db: Db, q: URLSearchParams): EventsPage {
  const after = intParam(q, "after");
  const limit = Math.min(intParam(q, "limit") ?? 200, 1000);
  const list = queryEvents(db, { after, taskId: intParam(q, "task"), runId: intParam(q, "run"), limit });
  return {
    events: list.map((e) => ({ id: e.id, taskId: e.taskId, runId: e.runId, kind: e.kind, payload: e.payload, createdAt: e.createdAt })),
    lastId: list.at(-1)?.id ?? after ?? 0,
  };
}
