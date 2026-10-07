import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appDbPath } from "../src/app.ts";
import { openDb } from "../src/db/connection.ts";
import { addRepo, createProject, setProjectProfile, setRepoProfile } from "../src/db/store.ts";
import { makeRepo, tempDir } from "./helpers/gitrepo.ts";
import { PROFILE } from "./helpers/project.ts";

const bin = new URL("../bin/agent-crew.js", import.meta.url).pathname;
const fake = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;

function cli(home: string, ...args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(process.execPath, [bin, ...args], { encoding: "utf8", env: { ...process.env, AGENT_CREW_HOME: home }, stdio: "pipe" }) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: err.stdout + err.stderr };
  }
}

describe("task の CLI", () => {
  it("create → run → show(人の回答待ちと理由)→ answer → list", () => {
    const home = tempDir("agent-crew-home-");
    writeFileSync(join(home, "config.json"), JSON.stringify({ claudePath: fake }));
    const { repo } = makeRepo();
    const db = openDb(appDbPath(home));
    const p = createProject(db, { name: "shop" });
    const r = addRepo(db, { projectId: p.id, path: repo, role: "main", defaultBranch: "main" });
    setRepoProfile(db, r.id, PROFILE);
    setProjectProfile(db, p.id, { profileStatus: "approved", testInfra: "present", profile: PROFILE });
    db.close();

    const body = join(home, "body.md");
    writeFileSync(body, "在庫0を一覧から除外する");
    expect(cli(home, "task", "create", "--project", "shop", "--title", "在庫0を除外", "--body-file", body).out).toContain("#1");

    // 偽の claude はプランナーとして不正な判定(done)を返すので、人の回答待ちになる
    const run = cli(home, "run");
    expect(run.out).toContain("#1");
    expect(run.out).toContain("人の回答待ち");

    const show = cli(home, "task", "show", "1");
    expect(show.out).toContain("人の回答待ち");
    expect(show.out).toContain("planner");
    expect(show.out).toMatch(/理由: .*判定/);

    expect(cli(home, "task", "answer", "1", "--message", "進めてください").code).toBe(0);
    expect(cli(home, "task", "list").out).toMatch(/#1\s+shop\s+計画中/);
    expect(cli(home, "task", "approve", "1", "--kind", "plan").code).toBe(1);
    expect(cli(home, "task", "cancel", "1").code).toBe(0);
    expect(cli(home, "task", "list").out).not.toContain("#1");
    expect(cli(home, "task", "list", "--all").out).toContain("取り消し");
  }, 60_000);
});
