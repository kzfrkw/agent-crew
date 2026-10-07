import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProject, createTask, finishRun, startRun } from "../src/db/store.ts";
import { openDb } from "../src/db/connection.ts";
import { acquireRunLock, recoverStaleRuns } from "../src/orchestrator/lock.ts";
import { tempDir } from "./helpers/gitrepo.ts";

describe("実行ロック", () => {
  it("同時に2つの run は動かせない。解放すれば取れる", () => {
    const home = tempDir("agent-crew-home-");
    const release = acquireRunLock(home);
    expect(() => acquireRunLock(home)).toThrow(/実行中/);
    release();
    acquireRunLock(home)();
  });

  it("持ち主のプロセスが無いロックは取り直せる", () => {
    const home = tempDir("agent-crew-home-");
    writeFileSync(join(home, "run.lock"), "99999999");
    acquireRunLock(home)();
  });

  it("中断された実行(running のまま)を failed にする", () => {
    const db = openDb(":memory:");
    const p = createProject(db, { name: "p" });
    const t = createTask(db, { projectId: p.id, title: "t", body: "" });
    const stale = startRun(db, { taskId: t.id, role: "planner" });
    const done = startRun(db, { taskId: t.id, role: "planner" });
    finishRun(db, done.id, { state: "succeeded" });
    expect(recoverStaleRuns(db)).toBe(1);
    expect(db.prepare("SELECT state FROM runs WHERE id = ?").get(stale.id)).toEqual({ state: "failed" });
  });
});
