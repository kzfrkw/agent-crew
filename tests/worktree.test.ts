import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  branchNameFor,
  commitsSince,
  createWorktree,
  diffFromBase,
  headSha,
  isDirty,
  removeWorktree,
  worktreePathFor,
} from "../src/git/worktree.ts";
import { git, gitEnv, makeRepo, sh, tempDir } from "./helpers/gitrepo.ts";

const env = gitEnv();

function setup() {
  const r = makeRepo();
  const home = tempDir("agent-crew-home-");
  const wt = worktreePathFor(home, { project: "shop", taskId: 7, repoRole: "main" });
  const created = createWorktree({ home, repoPath: r.repo, worktreePath: wt, branch: "agent-crew/7-add-login", base: "main", env });
  return { ...r, home, wt, created };
}

describe("名前と場所", () => {
  it("ブランチ名はタスクIDとASCIIのslug", () => {
    expect(branchNameFor(7, "Add Login Page!")).toBe("agent-crew/7-add-login-page");
    expect(branchNameFor(7, "ログイン画面を追加")).toBe("agent-crew/7");
    expect(branchNameFor(7, "x".repeat(100)).length).toBeLessThanOrEqual("agent-crew/7-".length + 40);
  });

  it("worktree はデータディレクトリの下", () => {
    expect(worktreePathFor("/h", { project: "shop", taskId: 7, repoRole: "backend" })).toBe("/h/worktrees/shop/7/backend");
  });
});

describe("createWorktree", () => {
  it("ブランチを作ってチェックアウトし、ベースのSHAを返す", () => {
    const { repo, wt, created } = setup();
    expect(existsSync(join(wt, "README.md"))).toBe(true);
    expect(git(wt, "branch", "--show-current")).toBe("agent-crew/7-add-login");
    expect(created.baseSha).toBe(git(repo, "rev-parse", "main"));
  });

  it("エージェントのworktreeにだけ hooksPath を設定する(元のチェックアウトは変えない)", () => {
    const { repo, wt, home } = setup();
    expect(git(wt, "config", "--get", "core.hooksPath")).toBe(join(home, "hooks"));
    expect(() => git(repo, "config", "--get", "core.hooksPath")).toThrow();
  });

  it("エージェントのworktreeからのpushは、環境変数が無くても失敗する", () => {
    const { wt } = setup();
    expect(() => git(wt, "push", "origin", "HEAD")).toThrow(/agent-crew/);
  });

  it("元のチェックアウトからの人のpushは止めない", () => {
    const { repo, remote } = setup();
    git(repo, "push", "-q", "origin", "main");
    expect(git(remote, "rev-parse", "main")).toBe(git(repo, "rev-parse", "main"));
  });

  it("pre-push 以外のフックは、リポジトリの元のフックに中継する(.git/hooks)", () => {
    const r = makeRepo();
    const marker = join(r.root, "pre-commit-ran");
    const hook = join(r.repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\necho ran > "${marker}"\n`);
    chmodSync(hook, 0o755);
    const home = tempDir("agent-crew-home-");
    const wt = worktreePathFor(home, { project: "p", taskId: 1, repoRole: "main" });
    createWorktree({ home, repoPath: r.repo, worktreePath: wt, branch: "agent-crew/1", base: "main", env });
    writeFileSync(join(wt, "a.txt"), "a");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "a");
    expect(readFileSync(marker, "utf8").trim()).toBe("ran");
  });

  it("リポジトリが core.hooksPath を使っている場合(husky など)も中継する", () => {
    const r = makeRepo();
    const marker = join(r.root, "commit-msg-ran");
    mkdirSync(join(r.repo, ".husky"));
    writeFileSync(join(r.repo, ".husky", "commit-msg"), `#!/bin/sh\necho "$1" > "${marker}"\n`);
    chmodSync(join(r.repo, ".husky", "commit-msg"), 0o755);
    git(r.repo, "add", ".");
    git(r.repo, "commit", "-q", "-m", "husky");
    git(r.repo, "config", "core.hooksPath", ".husky");
    const home = tempDir("agent-crew-home-");
    const wt = worktreePathFor(home, { project: "p", taskId: 2, repoRole: "main" });
    createWorktree({ home, repoPath: r.repo, worktreePath: wt, branch: "agent-crew/2", base: "main", env });
    writeFileSync(join(wt, "b.txt"), "b");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "b");
    expect(existsSync(marker)).toBe(true);
    // 中継先がpre-pushを持っていても、エージェントのworktreeでは必ず失敗する
    expect(() => git(wt, "push", "origin", "HEAD")).toThrow(/agent-crew/);
  });
});

describe("worktree の状態", () => {
  it("未コミットの変更を検出する", () => {
    const { wt } = setup();
    expect(isDirty(wt, env)).toBe(false);
    writeFileSync(join(wt, "new.txt"), "x");
    expect(isDirty(wt, env)).toBe(true);
  });

  it("ベース以降のコミットを、trailer でエージェントと人に分ける", () => {
    const { wt, created } = setup();
    writeFileSync(join(wt, "a.txt"), "a");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "feat: a\n\nAgent-Crew-Role: implementer");
    writeFileSync(join(wt, "b.txt"), "b");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "fix by hand");
    const commits = commitsSince(wt, created.baseSha, env);
    expect(commits.map((c) => [c.subject, c.agentRole])).toEqual([
      ["feat: a", "implementer"],
      ["fix by hand", null],
    ]);
    expect(headSha(wt, env)).toBe(commits[1]!.sha);
    expect(diffFromBase(wt, created.baseSha, env)).toContain("+b");
  });

  it("worktree を削除できる(ブランチは残す)", () => {
    const { repo, wt } = setup();
    removeWorktree({ repoPath: repo, worktreePath: wt, env });
    expect(existsSync(wt)).toBe(false);
    expect(sh(repo, "git", ["branch", "--list", "agent-crew/7-add-login"])).toContain("agent-crew/7-add-login");
  });

  it("未コミットの変更がある worktree は削除を拒否する", () => {
    const { repo, wt } = setup();
    writeFileSync(join(wt, "dirty.txt"), "x");
    expect(() => removeWorktree({ repoPath: repo, worktreePath: wt, env })).toThrow();
  });
});

describe("一時的なworktreeの片付け", () => {
  it("force と deleteBranch で、未追跡ファイルがあっても消し、ブランチも消す", () => {
    const { repo, wt } = setup();
    writeFileSync(join(wt, "build-output.txt"), "x");
    removeWorktree({ repoPath: repo, worktreePath: wt, env, force: true, deleteBranch: "agent-crew/7-add-login" });
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, "branch", "--list", "agent-crew/*")).toBe("");
  });
});

describe("エージェントのコミットへの trailer", () => {
  it("AGENT_CREW_ROLE があるときだけ、prepare-commit-msg が trailer を付ける(--no-verify でも)", () => {
    const { wt, created } = setup();
    writeFileSync(join(wt, "a.txt"), "a");
    git(wt, "add", ".");
    sh(wt, "git", ["commit", "-q", "--no-verify", "-m", "by agent"], { ...env, AGENT_CREW_ROLE: "implementer" });
    writeFileSync(join(wt, "b.txt"), "b");
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", "by human");
    expect(commitsSince(wt, created.baseSha, env).map((c) => [c.subject, c.agentRole])).toEqual([
      ["by agent", "implementer"],
      ["by human", null],
    ]);
  });
});
