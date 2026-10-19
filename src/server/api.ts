import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appDbPath } from "../app.ts";
import { splitFrontmatter } from "../util/frontmatter.ts";
import type { Db } from "../db/connection.ts";
import {
  costByTask,
  getArtifact,
  getProject,
  getProjectProfile,
  getProjectSettings,
  getProjectWiring,
  getRepoProfile,
  getRepoProtect,
  listChildren,
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
import { projectDir, runDir, taskDir } from "../orchestrator/paths.ts";
import { buildTaskReport } from "../orchestrator/report.ts";
import { getUsage } from "../orchestrator/usage.ts";
import { retroView } from "../orchestrator/retro.ts";
import { criticQuestion, planningQuestions, STAGES } from "../orchestrator/planning.ts";
import { STATE_LABELS, type TaskState } from "../orchestrator/states.ts";
import { glossaryPath } from "../orchestrator/glossary.ts";
import type {
  ArtifactDetail,
  ArtifactSummary,
  EventsPage,
  Overview,
  ProjectDetail,
  ProjectSummary,
  RunDetail,
  RunSummary,
  ScreenshotView,
  TaskDetail,
  TaskSummary,
  WorkerView,
  UsageView,
  ProjectSettingsView,
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

/** /api/ 以下の要求に答える。見つからなければ HttpError を投げる。worker は常駐ワーカーの状態 */
export function handleApi(home: string, path: string, query: URLSearchParams, worker: WorkerView = { state: "disabled", active: [] }): unknown {
  const db = openReadOnly(home);
  if (!db) {
    if (path === "overview") return { ...emptyOverview(), worker };
    if (path === "events") return { events: [], lastId: 0 } satisfies EventsPage;
    throw new HttpError(404, "まだデータがありません");
  }
  try {
    if (path === "overview") return { ...overview(db), worker };
    if (path === "events") return events(db, query);
    const m = /^(tasks|runs|artifacts|projects)\/(\d+)$/.exec(path);
    if (m) {
      const id = Number(m[2]);
      const found =
        m[1] === "tasks" ? taskDetail(home, db, id, worker.state !== "disabled") : m[1] === "runs" ? runDetail(home, db, id) : m[1] === "artifacts" ? artifactDetail(home, db, id) : projectDetail(home, db, id, worker.state !== "disabled");
      if (!found) throw new HttpError(404, "ありません");
      return found;
    }
    throw new HttpError(404, "ありません");
  } finally {
    db.close();
  }
}

// ---- 変換 ----

export const projectSummary = (db: Db, p: Project): ProjectSummary => ({
  id: p.id,
  name: p.name,
  profileStatus: p.profileStatus,
  testInfra: p.testInfra,
  allowWithoutTests: p.allowWithoutTests,
  repoCount: listRepos(db, p.id).length,
  activeTasks: listTasks(db, { projectId: p.id }).filter((t) => t.state !== "done" && t.state !== "cancelled").length,
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

function taskSummary(db: Db, t: Task, running: Map<number, RunRow>, costs: Map<number, number>): TaskSummary {
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
    design: t.design,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    attention,
    reason:
      attention === "answer" || attention === "failed"
        ? (latestReason(db, t.id, t.state as "needs_input" | "failed") ?? null)
        : attention === "approve_planning"
          ? criticQuestion(db, t.id)
          : null,
    running: r ? { id: r.id, role: r.role, model: r.model, startedAt: r.startedAt } : null,
    primaryAction: attention ? (nextActions(db, t)[0] ?? null) : null,
    costUsd: costs.get(t.id) ?? null,
    flow: t.flow,
    flowStage: t.flow === "coordinator" ? lastWrittenStage(db, t.id) : null,
  };
}

/** 最後に書いた企画の段(コーディネーターのタスクのパイプライン。フェーズ10) */
function lastWrittenStage(db: Db, taskId: number): TaskState | null {
  for (const r of listRuns(db, { taskId }).reverse()) {
    const entry = Object.entries(STAGES).find(([, s]) => s.writer === r.role);
    if (entry) return entry[0] as TaskState;
  }
  return null;
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
export { splitFrontmatter };

const markdownBody = (text: string | null) => (text === null ? null : splitFrontmatter(text).body);

// ---- 各 API ----

/** タスクの要約(書き込み API の結果にも使う) */
export function taskSummaryOf(db: Db, id: number): TaskSummary | undefined {
  const t = getTask(db, id);
  return t && taskSummary(db, t, runningByTask(db), costByTask(db));
}

function emptyOverview(): Omit<Overview, "worker"> {
  return { projects: [], tasks: [], running: [], stateLabels: STATE_LABELS, usage: null };
}

function overview(db: Db): Omit<Overview, "worker"> {
  const running = runningByTask(db);
  const costs = costByTask(db);
  const tasks = listTasks(db);
  const titles = new Map(tasks.map((t) => [t.id, t.title]));
  return {
    projects: listProjects(db).map((p) => projectSummary(db, p)),
    tasks: tasks.map((t) => taskSummary(db, t, running, costs)),
    running: listRuns(db, { state: "running" }).map((r) => ({ ...runSummary(r), taskTitle: r.taskId === null ? null : (titles.get(r.taskId) ?? null) })),
    stateLabels: STATE_LABELS,
    usage: usageView(db),
  };
}

const WINDOW_LABELS: Record<string, string> = { five_hour: "5時間", seven_day: "7日" };

function usageView(db: Db): UsageView | null {
  const u = getUsage(db);
  if (!u) return null;
  return {
    status: u.status,
    updatedAt: u.updatedAt,
    windows: (["five_hour", "seven_day"] as const).flatMap((key) => (u.windows[key] ? [{ key, label: WINDOW_LABELS[key]!, ...u.windows[key]! }] : [])),
  };
}

function taskDetail(home: string, db: Db, id: number, operable: boolean): TaskDetail | undefined {
  const t = getTask(db, id);
  if (!t) return undefined;
  const runs = listRuns(db, { taskId: id }).map(runSummary);
  const task = taskSummary(db, t, runningByTask(db), costByTask(db));
  const roles = new Map(listRepos(db, t.projectId).map((r) => [r.id, r.role]));
  return {
    task: { ...task, body: t.body, sourceKind: t.sourceKind, sourceUrl: t.sourceUrl },
    project: projectSummary(db, getProject(db, t.projectId)!),
    worktrees: listTaskRepos(db, id).map((tr) => ({
      repoRole: roles.get(tr.repoId) ?? "",
      worktreePath: tr.worktreePath,
      branchName: tr.branchName,
      baseSha: tr.baseSha,
      removed: (t.state === "done" || t.state === "cancelled") && !existsSync(tr.worktreePath),
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
      costUsd: task.costUsd,
      durationSec: runs.reduce((s, r) => s + (r.durationSec ?? 0), 0),
    },
    nextActions: nextActions(db, t),
    runActive: runActive(db, id),
    screenshots: screenshotsOf(home, db, id),
    reviewFiles: { diff: fileUrl(home, join(taskDir(home, id), "diff.patch")), testChanges: fileUrl(home, join(taskDir(home, id), "test-changes.md")) },
    settings: projectSettingsView(db, t.projectId),
    report: buildTaskReport(db, id),
    retro: retroView(db, id),
    planningQuestions: t.kind === "planning" && t.state.startsWith("awaiting_") ? planningQuestions(db, id) : null,
    parent: t.parentId === null ? null : { id: t.parentId, title: getTask(db, t.parentId)?.title ?? "" },
    children: listChildren(db, id).map((c) => ({ id: c.id, title: c.title, seq: c.seq ?? 0, state: c.state, stateLabel: STATE_LABELS[c.state] })),
    operable,
  };
}

/** 最新の撮影(screens のイベント)の画面。画像は成果物ディレクトリの screens/ にある */
function screenshotsOf(home: string, db: Db, taskId: number): ScreenshotView[] {
  const ev = queryEvents(db, { taskId, limit: 1000 }).filter((e) => e.kind === "screens").at(-1);
  const shots = ((ev?.payload as { shots?: Omit<ScreenshotView, "url">[] } | undefined)?.shots ?? []);
  return shots.map((s) => ({ ...s, url: s.error ? null : fileUrl(home, join(taskDir(home, taskId), "screens", s.file)) }));
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
    project: project ? projectSummary(db, project) : null,
    artifacts: listRunArtifacts(db, id).map((a) => artifactSummary(home, a)),
    streamUrl: fileUrl(home, join(runDir(home, id), "stream.jsonl")),
  };
}

/** 画面に出すプロジェクトの設定(未設定は既定値で補う) */
export function projectSettingsView(db: Db, projectId: number): ProjectSettingsView {
  const s = getProjectSettings(db, projectId);
  return { integrate: s.integrate ?? "pr", autoApprovePlan: s.autoApprovePlan === true, retrospective: s.retrospective !== false, coordinator: s.coordinator === true, explain: s.explain !== false };
}

function projectDetail(home: string, db: Db, id: number, operable: boolean): ProjectDetail | undefined {
  const p = getProject(db, id);
  if (!p) return undefined;
  const running = runningByTask(db);
  const costs = costByTask(db);
  return {
    project: projectSummary(db, p),
    settings: projectSettingsView(db, id),
    operable,
    // 画面の節に見出しがあるので、ファイルの先頭の見出し(# 用語集)は除く
    glossaryMd: readText(glossaryPath(home, id))?.replace(/^# .*\n+/, "") ?? null,
    repos: listRepos(db, id).map((r) => ({
      id: r.id,
      path: r.path,
      role: r.role,
      defaultBranch: r.defaultBranch,
      profile: getRepoProfile(db, r.id),
      env: getProjectWiring(db, id)[r.role] ?? {},
      protect: getRepoProtect(db, r.id),
    })),
    profile: getProjectProfile(db, id),
    profileMd: markdownBody(readText(join(projectDir(home, id), "profile.md"))),
    decisionsMd: readText(join(projectDir(home, id), "decisions.md")),
    runs: listRuns(db, { projectId: id }).filter((r) => r.taskId === null).map(runSummary),
    tasks: listTasks(db, { projectId: id }).map((t) => taskSummary(db, t, running, costs)),
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
  const kinds = q.get("kinds")?.split(",").map((k) => k.trim()).filter(Boolean);
  const list = queryEvents(db, { after, taskId: intParam(q, "task"), runId: intParam(q, "run"), kinds, limit });
  return {
    events: list.map((e) => ({ id: e.id, taskId: e.taskId, runId: e.runId, kind: e.kind, payload: e.payload, createdAt: e.createdAt })),
    lastId: list.at(-1)?.id ?? after ?? 0,
  };
}
