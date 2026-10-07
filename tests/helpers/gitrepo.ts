import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** テスト用の環境変数: 親プロセス(Claude Code)の変数や個人のgit設定の影響を受けないようにする */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_") || k === "CLAUDECODE" || k === "AGENT_CREW_RUN") delete env[k];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Tester",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "Tester",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
}

export function sh(cwd: string, cmd: string, args: string[], env = gitEnv()): string {
  return execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

export const git = (cwd: string, ...args: string[]) => sh(cwd, "git", args);

export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** main ブランチに1コミットあるリポジトリと、そのpush先のbareリポジトリを作る */
export function makeRepo(): { root: string; repo: string; remote: string } {
  const root = tempDir("agent-crew-git-");
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", remote);
  git(root, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", remote);
  return { root, repo, remote };
}
