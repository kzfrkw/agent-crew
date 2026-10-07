import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { appDbPath } from "../src/app.ts";
import { openDb } from "../src/db/connection.ts";
import { addRepo, attachRepoToTask, createProject, createTask } from "../src/db/store.ts";
import { tempDir } from "./helpers/gitrepo.ts";

const bin = new URL("../bin/agent-crew.js", import.meta.url).pathname;
const run = (home: string, ...args: string[]) =>
  execFileSync(process.execPath, [bin, ...args], { encoding: "utf8", env: { ...process.env, AGENT_CREW_HOME: home }, stdio: "pipe" });

describe("agent-crew task worktree", () => {
  it("タスクのworktreeのパスを表示する(複数リポジトリなら役目ごと)", () => {
    const home = tempDir("agent-crew-home-");
    const db = openDb(appDbPath(home));
    const p = createProject(db, { name: "shop" });
    const api = addRepo(db, { projectId: p.id, path: "/r/api", role: "backend", defaultBranch: "main" });
    const web = addRepo(db, { projectId: p.id, path: "/r/web", role: "frontend", defaultBranch: "main" });
    const t = createTask(db, { projectId: p.id, title: "x", body: "" });
    attachRepoToTask(db, { taskId: t.id, repoId: api.id, worktreePath: "/wt/1/backend", branchName: "agent-crew/1", baseSha: "a" });
    attachRepoToTask(db, { taskId: t.id, repoId: web.id, worktreePath: "/wt/1/frontend", branchName: "agent-crew/1", baseSha: "b" });
    db.close();
    expect(run(home, "task", "worktree", String(t.id)).trim().split("\n")).toEqual([
      "backend\t/wt/1/backend\tagent-crew/1",
      "frontend\t/wt/1/frontend\tagent-crew/1",
    ]);
  });

  it("存在しないタスクはエラー", () => {
    const home = tempDir("agent-crew-home-");
    expect(() => run(home, "task", "worktree", "99")).toThrow(/タスク 99/);
  });
});
