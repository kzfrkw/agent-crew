import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./git.ts";
import { installAgentHooks } from "./hooks.ts";

type Env = NodeJS.ProcessEnv;

/** エージェントのコミットに付ける trailer のキー。無いコミットは人の変更とみなす */
export const ROLE_TRAILER = "Agent-Crew-Role";

export function worktreePathFor(home: string, t: { project: string; taskId: number; repoRole: string }): string {
  return join(home, "worktrees", t.project, String(t.taskId), t.repoRole);
}

/** 複数リポジトリのタスクでも共通にするブランチ名 */
export function branchNameFor(taskId: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug ? `agent-crew/${taskId}-${slug}` : `agent-crew/${taskId}`;
}

/**
 * worktree を作り、そのworktreeにだけエージェント用のフックを効かせる。
 * 対象リポジトリのローカル設定 extensions.worktreeConfig を有効にする(doctor で表示する)。
 */
export function createWorktree(o: {
  home: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  base: string;
  env?: Env;
}): { baseSha: string } {
  if (existsSync(o.worktreePath)) throw new Error(`worktree の場所がすでに存在します: ${o.worktreePath}`);
  const baseSha = git(o.repoPath, ["rev-parse", "--verify", `${o.base}^{commit}`], o.env);
  mkdirSync(dirname(o.worktreePath), { recursive: true });
  git(o.repoPath, ["config", "extensions.worktreeConfig", "true"], o.env);
  git(o.repoPath, ["worktree", "add", "-q", "-b", o.branch, o.worktreePath, baseSha], o.env);
  const hooksDir = installAgentHooks(o.home);
  git(o.worktreePath, ["config", "--worktree", "core.hooksPath", hooksDir], o.env);
  return { baseSha };
}

/**
 * worktree を削除する。既定ではブランチは人がpushするために残し、未コミットの変更があれば git が拒否する。
 * force / deleteBranch は、ツールが作った一時的なworktree(調査用など)の片付けにだけ使う。
 */
export function removeWorktree(o: { repoPath: string; worktreePath: string; env?: Env; force?: boolean; deleteBranch?: string }): void {
  git(o.repoPath, ["worktree", "remove", ...(o.force ? ["--force"] : []), o.worktreePath], o.env);
  if (o.deleteBranch) git(o.repoPath, ["branch", "-D", o.deleteBranch], o.env);
}

export function isDirty(worktree: string, env?: Env): boolean {
  return git(worktree, ["status", "--porcelain"], env) !== "";
}

/** 追跡しているファイルの変更(未追跡のファイルは含めない) */
export function hasTrackedChanges(worktree: string, env?: Env): boolean {
  return git(worktree, ["status", "--porcelain", "--untracked-files=no"], env) !== "";
}

export function headSha(worktree: string, env?: Env): string {
  return git(worktree, ["rev-parse", "HEAD"], env);
}

export function diffFromBase(worktree: string, baseSha: string, env?: Env): string {
  return git(worktree, ["diff", `${baseSha}..HEAD`], env);
}

/** HEAD と ref の分岐点(ベース更新で取り込んだ変更を差分に含めないため) */
export function mergeBase(worktree: string, ref: string, env?: Env): string {
  return git(worktree, ["merge-base", "HEAD", ref], env);
}

export function changedFiles(worktree: string, from: string, env?: Env): { status: string; path: string }[] {
  return git(worktree, ["diff", "--name-status", `${from}..HEAD`], env)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const parts = l.split("\t");
      return { status: parts[0]!, path: parts.at(-1)! };
    });
}

/** ref が HEAD に含まれているか(ベースに追従できているか) */
export function containsRef(worktree: string, ref: string, env?: Env): boolean {
  try {
    git(worktree, ["merge-base", "--is-ancestor", ref, "HEAD"], env);
    return true;
  } catch {
    return false;
  }
}

export function diffStat(worktree: string, from: string, env?: Env): string {
  return git(worktree, ["diff", "--stat", `${from}..HEAD`], env);
}

export type CommitInfo = { sha: string; author: string; subject: string; agentRole: string | null };

/** ベース以降のコミット(古い順)。trailer の有無でエージェントと人を区別する */
export function commitsSince(worktree: string, baseSha: string, env?: Env): CommitInfo[] {
  const out = git(
    worktree,
    ["log", "--reverse", `--format=%H%x1f%an%x1f%s%x1f%(trailers:key=${ROLE_TRAILER},valueonly,separator=%x2c)%x1e`, `${baseSha}..HEAD`],
    env,
  );
  return out
    .split("\x1e")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, author, subject, role] = line.split("\x1f");
      return { sha: sha!, author: author!, subject: subject!, agentRole: role?.trim() || null };
    });
}
