import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addRepo,
  createProject,
  createTask,
  getProject,
  getProjectByName,
  getTask,
  listRepos,
  listTasks,
  setAllowWithoutTests,
  setProjectProfile,
  setRepoProfile,
  type Project,
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

/** プロジェクトとリポジトリを登録し、プロジェクト把握担当にプロファイルを作らせる(設計メモ5.1) */
export async function registerProject(ctx: AppContext, o: { name: string; repoPath: string; role?: string }): Promise<ProfileOutcome> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(o.name)) throw new Error(`プロジェクト名は英数字・-・_ だけにしてください: ${o.name}`);
  if (getProjectByName(ctx.db, o.name)) throw new Error(`プロジェクト ${o.name} はすでに登録されています`);
  if (!existsSync(o.repoPath)) throw new Error(`パスがありません: ${o.repoPath}`);
  const repoPath = realpathSync(o.repoPath);
  let top: string;
  try {
    top = realpathSync(git(repoPath, ["rev-parse", "--show-toplevel"], ctx.gitEnv));
  } catch {
    throw new Error(`git リポジトリではありません: ${repoPath}`);
  }
  if (top !== repoPath) throw new Error(`リポジトリのルートを指定してください(ルート: ${top})`);
  let defaultBranch: string;
  try {
    defaultBranch = git(repoPath, ["symbolic-ref", "--short", "HEAD"], ctx.gitEnv);
  } catch {
    throw new Error(`ブランチがチェックアウトされていません(detached HEAD): ${repoPath}`);
  }

  const project = createProject(ctx.db, { name: o.name });
  addRepo(ctx.db, { projectId: project.id, path: repoPath, role: o.role ?? "main", defaultBranch });
  const dir = projectDir(ctx.home, project.id);
  mkdirSync(dir, { recursive: true });
  const decisions = join(dir, "decisions.md");
  if (!existsSync(decisions)) {
    writeFileSync(decisions, "# 設計判断ログ\n\n重要な設計判断とその理由を、新しいものを下に追記する。\n");
  }
  return profileProject(ctx, project);
}

/** プロファイルを作り直す */
export function reprofileProject(ctx: AppContext, name: string): Promise<ProfileOutcome> {
  return profileProject(ctx, mustProject(ctx.db, name));
}

async function profileProject(ctx: AppContext, project: Project): Promise<ProfileOutcome> {
  const repo = listRepos(ctx.db, project.id)[0];
  if (!repo) throw new Error(`プロジェクト ${project.name} にリポジトリがありません`);
  const dir = projectDir(ctx.home, project.id);
  const stamp = Date.now();
  const worktree = join(ctx.home, "worktrees", project.name, `_profile-${stamp}`, repo.role);
  const branch = `agent-crew/profile-${project.id}-${stamp}`;
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
      setProjectProfile(ctx.db, project.id, { profileStatus: "none" });
      return { ok: false, reason: r.reason };
    }
    const profile = ProfileSchema.parse(r.extra.profile);
    writeFileSync(join(dir, "profile.json"), JSON.stringify(profile, null, 2));
    setRepoProfile(ctx.db, repo.id, profile);
    setProjectProfile(ctx.db, project.id, { profileStatus: "draft", testInfra: profile.testInfra, profile });
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
