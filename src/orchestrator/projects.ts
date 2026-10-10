import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addRepo,
  createProject,
  createTask,
  getProject,
  getProjectByName,
  getProjectWiring,
  getRepoProfile,
  getTask,
  listRepos,
  listTasks,
  setAllowWithoutTests,
  setProjectProfile,
  setProjectWiring,
  setRepoProfile,
  type Project,
  type Repo,
  type Wiring,
  type Task,
} from "../db/store.ts";
import type { Db } from "../db/connection.ts";
import { git } from "../git/git.ts";
import { createWorktree, removeWorktree } from "../git/worktree.ts";
import { ProfileSchema, type Profile } from "../roles/schemas.ts";
import type { AppContext } from "./context.ts";
import { invokeRole } from "./invoke.ts";
import { projectDir } from "./paths.ts";
import { profilerPrompt } from "./prompts.ts";

export type ProfileOutcome = { ok: true; verdict: string; summary: string; profile: Profile } | { ok: false; reason: string };

/** git リポジトリのルートを確かめ、実体のパスと既定ブランチを返す */
function inspectRepo(ctx: AppContext, path: string): { repoPath: string; defaultBranch: string } {
  if (!existsSync(path)) throw new Error(`パスがありません: ${path}`);
  const repoPath = realpathSync(path);
  let top: string;
  try {
    top = realpathSync(git(repoPath, ["rev-parse", "--show-toplevel"], ctx.gitEnv));
  } catch {
    throw new Error(`git リポジトリではありません: ${repoPath}`);
  }
  if (top !== repoPath) throw new Error(`リポジトリのルートを指定してください(ルート: ${top})`);
  try {
    return { repoPath, defaultBranch: git(repoPath, ["symbolic-ref", "--short", "HEAD"], ctx.gitEnv) };
  } catch {
    throw new Error(`ブランチがチェックアウトされていません(detached HEAD): ${repoPath}`);
  }
}

const ROLE_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** プロジェクトとリポジトリを登録し、プロジェクト把握担当にプロファイルを作らせる(設計メモ5.1) */
export async function registerProject(ctx: AppContext, o: { name: string; repoPath: string; role?: string }): Promise<ProfileOutcome> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(o.name)) throw new Error(`プロジェクト名は英数字・-・_ だけにしてください: ${o.name}`);
  if (getProjectByName(ctx.db, o.name)) throw new Error(`プロジェクト ${o.name} はすでに登録されています`);
  const role = o.role ?? "main";
  if (!ROLE_NAME.test(role)) throw new Error(`役目は英小文字・数字・-・_ だけにしてください: ${role}`);
  const { repoPath, defaultBranch } = inspectRepo(ctx, o.repoPath);

  const project = createProject(ctx.db, { name: o.name });
  const repo = addRepo(ctx.db, { projectId: project.id, path: repoPath, role, defaultBranch });
  const dir = projectDir(ctx.home, project.id);
  mkdirSync(dir, { recursive: true });
  const decisions = join(dir, "decisions.md");
  if (!existsSync(decisions)) {
    writeFileSync(decisions, "# 設計判断ログ\n\n重要な設計判断とその理由を、新しいものを下に追記する。\n");
  }
  return profileRepo(ctx, project, repo);
}

/**
 * プロジェクトにリポジトリを追加し、そのリポジトリのプロファイルを作らせる(設計メモ v0.14)。
 * プロジェクトのプロファイルは承認待ちに戻る(全リポジトリのプロファイルがそろってから承認する)
 */
export async function addRepository(ctx: AppContext, o: { name: string; repoPath: string; role: string }): Promise<ProfileOutcome> {
  const project = mustProject(ctx.db, o.name);
  if (!ROLE_NAME.test(o.role)) throw new Error(`役目は英小文字・数字・-・_ だけにしてください: ${o.role}`);
  if (listRepos(ctx.db, project.id).some((r) => r.role === o.role)) throw new Error(`役目 ${o.role} のリポジトリはすでに登録されています`);
  const { repoPath, defaultBranch } = inspectRepo(ctx, o.repoPath);
  const repo = addRepo(ctx.db, { projectId: project.id, path: repoPath, role: o.role, defaultBranch });
  return profileRepo(ctx, project, repo);
}

/** プロファイルを作り直す(役目を指定しなければ全リポジトリ) */
export async function reprofileProject(ctx: AppContext, name: string, role?: string): Promise<ProfileOutcome> {
  const project = mustProject(ctx.db, name);
  const repos = listRepos(ctx.db, project.id).filter((r) => role === undefined || r.role === role);
  if (repos.length === 0) throw new Error(`プロジェクト ${name} に${role ? `役目 ${role} の` : ""}リポジトリがありません`);
  let last: ProfileOutcome = { ok: false, reason: "リポジトリがありません" };
  for (const repo of repos) {
    last = await profileRepo(ctx, project, repo);
    if (!last.ok) return last;
  }
  return last;
}

/** リポジトリのプロファイルの文書の置き場所。1つ目はプロジェクトのデータディレクトリ、2つ目以降は repos/<役目>/ */
export function repoProfileDir(ctx: { home: string; db: Db }, projectId: number, role: string): string {
  const first = listRepos(ctx.db, projectId)[0];
  return first && first.role === role ? projectDir(ctx.home, projectId) : join(projectDir(ctx.home, projectId), "repos", role);
}

const STRENGTH: Profile["testInfra"][] = ["none", "insufficient", "present"];

/** プロジェクトのプロファイルを全リポジトリから組み立てる: テスト基盤は最も弱いもの、全体の項目は1つ目のリポジトリ */
function refreshProjectProfile(ctx: AppContext, project: Project): void {
  const profiles = listRepos(ctx.db, project.id).map((r) => getRepoProfile(ctx.db, r.id) as Profile | null);
  const known = profiles.filter((p): p is Profile => p !== null);
  if (known.length === 0) return setProjectProfile(ctx.db, project.id, { profileStatus: "none" });
  const weakest = known.map((p) => p.testInfra).sort((a, b) => STRENGTH.indexOf(a) - STRENGTH.indexOf(b))[0]!;
  setProjectProfile(ctx.db, project.id, { profileStatus: "draft", testInfra: weakest, profile: known[0] });
}

async function profileRepo(ctx: AppContext, project: Project, repo: Repo): Promise<ProfileOutcome> {
  const dir = repoProfileDir(ctx, project.id, repo.role);
  mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const worktree = join(ctx.home, "worktrees", project.name, `_profile-${stamp}`, repo.role);
  const branch = `agent-crew/profile-${project.id}-${repo.role}-${stamp}`;
  createWorktree({ home: ctx.home, repoPath: repo.path, worktreePath: worktree, branch, base: repo.defaultBranch, env: ctx.gitEnv });
  try {
    const r = await invokeRole(ctx, {
      roleName: "profiler",
      projectId: project.id,
      cwd: worktree,
      artifactsDir: dir,
      prompt: profilerPrompt({ projectName: project.name, repoPath: repo.path, worktree, artifactsDir: dir }),
    });
    if (!r.ok) {
      refreshProjectProfile(ctx, project);
      return { ok: false, reason: r.reason };
    }
    const profile = ProfileSchema.parse(r.extra.profile);
    writeFileSync(join(dir, "profile.json"), JSON.stringify(profile, null, 2));
    setRepoProfile(ctx.db, repo.id, profile);
    refreshProjectProfile(ctx, project);
    return { ok: true, verdict: r.verdict, summary: r.summary, profile };
  } finally {
    removeWorktree({ repoPath: repo.path, worktreePath: worktree, env: ctx.gitEnv, force: true, deleteBranch: branch });
  }
}

/**
 * 人がプロファイルを承認する。テスト基盤が無い/不十分なら「テスト基盤整備」タスクを作る(設計メモ5.1の4)。
 * allowWithoutTests は、整備が終わる前に通常タスクを始めることを人が許可した記録。
 */
export function approveProfile(ctx: AppContext, name: string, o: { allowWithoutTests?: boolean } = {}): { project: Project; testInfraTask?: Task } {
  const project = mustProject(ctx.db, name);
  if (project.profileStatus === "none") throw new Error(`プロジェクト ${name} のプロファイルがありません(project profile ${name} で作り直してください)`);
  const missing = listRepos(ctx.db, project.id).filter((r) => getRepoProfile(ctx.db, r.id) === null).map((r) => r.role);
  if (missing.length > 0) throw new Error(`プロファイルの無いリポジトリがあります: ${missing.join(", ")}(project profile ${name} --role <役目> で作ってください)`);
  setProjectProfile(ctx.db, project.id, { profileStatus: "approved" });
  if (o.allowWithoutTests) setAllowWithoutTests(ctx.db, project.id, true);

  let testInfraTask: Task | undefined;
  if (project.testInfra !== "present") {
    const existing = listTasks(ctx.db, { projectId: project.id }).find((t) => t.kind === "test_infra" && t.state !== "cancelled");
    testInfraTask = existing ?? createTask(ctx.db, {
      projectId: project.id,
      kind: "test_infra",
      title: "テスト基盤整備",
      body: testInfraTaskBody(ctx.db, project.id),
    });
  }
  return { project: getProject(ctx.db, project.id)!, testInfraTask };
}

function testInfraTaskBody(db: Db, projectId: number): string {
  const repo = listRepos(db, projectId)[0];
  const profile = repo ? (ProfileSchema.safeParse(JSON.parse((db.prepare("SELECT profile_json FROM repos WHERE id = ?").get(repo.id) as { profile_json: string }).profile_json ?? "null")).data ?? null) : null;
  return `このプロジェクトには、自動テストの基盤が無いか不十分です(テスト先行で開発するための前提)。

## 目的
- 全テストを1つのコマンドで実行でき、終了コードで合否が分かる状態にする
- 既存の主要な振る舞いに、最小限の回帰テストを付ける
- テストの実行方法を README などに記載する

## プロジェクト把握担当の調査結果
${profile ? `- テスト基盤: ${profile.testInfra}\n- 詳細: ${profile.testInfraNotes}` : "(プロファイルを参照)"}

## 注意
- アプリの振る舞いは変えない
- 導入するテストの道具は、プロジェクトの言語・フレームワークで標準的なものを選び、理由を plan.md に書く
`;
}

/** テスト基盤のゲート: 整備タスク自身、テスト基盤あり、または人が例外を許可した場合だけ開始できる */
export function testGateOpen(db: Db, taskId: number): boolean {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`タスク ${taskId} がありません`);
  const project = getProject(db, task.projectId)!;
  return task.kind === "test_infra" || project.testInfra === "present" || project.allowWithoutTests;
}

export function mustProject(db: Db, name: string): Project {
  const p = getProjectByName(db, name);
  if (!p) throw new Error(`プロジェクト ${name} がありません`);
  return p;
}

export type ProfileCommandsPatch = Partial<Record<"install" | "build" | "test" | "start" | "startUrl", string>>;

/**
 * 役割に渡すコマンド(依存の準備・ビルド・テスト・起動・確認URL)を人が直す。正本は DB のプロファイル(profile.md は説明の文書)。
 * 指定しなかった項目は変えない。"-" は「なし」(null)。リポジトリ単位とプロジェクト全体の両方を直す(フェーズ1は1リポジトリ)
 */
export function setProfileCommands(ctx: AppContext, name: string, patch: ProfileCommandsPatch, role?: string): Profile {
  const project = mustProject(ctx.db, name);
  const repos = listRepos(ctx.db, project.id);
  const repo = role === undefined ? repos[0] : repos.find((r) => r.role === role);
  if (role !== undefined && !repo) throw new Error(`プロジェクト ${name} に役目 ${role} のリポジトリがありません`);
  const current = repo ? (getRepoProfile(ctx.db, repo.id) as Profile | null) : null;
  if (!repo || !current) throw new Error(`プロジェクト ${name} のプロファイルがありません。agent-crew project profile ${name} で作ってください`);
  const value = (v: string | undefined, prev: string | null) => (v === undefined ? prev : v.trim() === "-" ? null : v.trim());
  const next: Profile = ProfileSchema.parse({
    ...current,
    commands: {
      install: value(patch.install, current.commands.install),
      build: value(patch.build, current.commands.build),
      test: value(patch.test, current.commands.test),
      start: value(patch.start, current.commands.start),
    },
    startUrl: value(patch.startUrl, current.startUrl),
  });
  setRepoProfile(ctx.db, repo.id, next);
  // プロジェクト全体の項目は1つ目のリポジトリのもの
  if (repo.id === repos[0]!.id) setProjectProfile(ctx.db, project.id, { profile: next });
  return next;
}

const PLACEHOLDER = /\{(url|port):([^}]+)\}/g;

/** 起動のつなぎ方を設定する(役目ごとの環境変数。設計メモ v0.14)。値の {url:<役目>} / {port:<役目>} は起動のときに置き換える */
export function setRepoWiring(ctx: AppContext, name: string, role: string, env: Record<string, string>): Wiring {
  const project = mustProject(ctx.db, name);
  const repos = listRepos(ctx.db, project.id);
  if (!repos.some((r) => r.role === role)) throw new Error(`プロジェクト ${name} に役目 ${role} のリポジトリがありません`);
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`環境変数の名前が不正です: ${k}`);
    for (const m of v.matchAll(PLACEHOLDER)) {
      const target = repos.find((r) => r.role === m[2]);
      if (!target) throw new Error(`${k} の値が、無い役目 ${m[2]} を指しています`);
      if (!(getRepoProfile(ctx.db, target.id) as Profile | null)?.startUrl) throw new Error(`${k} の値が指す役目 ${m[2]} のリポジトリに、確認 URL がありません`);
    }
  }
  const wiring = getProjectWiring(ctx.db, project.id);
  wiring[role] = { ...(wiring[role] ?? {}), ...env };
  for (const [k, v] of Object.entries(env)) if (v === "-") delete wiring[role]![k];
  setProjectWiring(ctx.db, project.id, wiring);
  return wiring;
}

/** 役目のリポジトリを起動するときの環境変数(つなぎ方の値を、各リポジトリの確認 URL / ポートに置き換えたもの) */
export function resolveServiceEnv(db: Db, projectId: number, role: string): Record<string, string> {
  const repos = listRepos(db, projectId);
  const url = (r: string) => {
    const target = repos.find((x) => x.role === r);
    const u = target ? (getRepoProfile(db, target.id) as Profile | null)?.startUrl : null;
    if (!u) throw new Error(`役目 ${r} のリポジトリに確認 URL がありません`);
    return u;
  };
  const env = getProjectWiring(db, projectId)[role] ?? {};
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k, v.replace(PLACEHOLDER, (_m, kind: string, r: string) => (kind === "url" ? url(r) : new URL(url(r)).port || (new URL(url(r)).protocol === "https:" ? "443" : "80")))]),
  );
}
