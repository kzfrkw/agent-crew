import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectByName, listRepos, listTasks, createTask } from "../src/db/store.ts";
import { approveProfile, registerProject, testGateOpen, reprofileProject } from "../src/orchestrator/projects.ts";
import { answer, ScriptedRunner } from "./helpers/scripted-runner.ts";
import { testContext } from "./helpers/context.ts";
import { git, makeRepo } from "./helpers/gitrepo.ts";

const profile = (testInfra: "present" | "insufficient" | "none") => ({
  testInfra, testInfraNotes: "notes", conventions: "", qaMethod: "curl",
  commands: { install: "npm ci", build: null, test: testInfra === "none" ? null : "npm test", start: "npm start" },
  startUrl: "http://127.0.0.1:3000/",
});

const profiler = (testInfra: "present" | "insufficient" | "none", verdict = "ready") =>
  answer("profile.md", verdict, { profile: profile(testInfra) });

describe("registerProject", () => {
  it("登録し、調査用worktreeでプロジェクト把握担当を動かし、片付ける", async () => {
    const runner = new ScriptedRunner({ profiler: profiler("present") });
    const ctx = testContext(runner);
    const { repo } = makeRepo();
    const r = await registerProject(ctx, { name: "shop", repoPath: repo });
    expect(r).toMatchObject({ ok: true, verdict: "ready" });

    const p = getProjectByName(ctx.db, "shop")!;
    expect(p).toMatchObject({ profileStatus: "draft", testInfra: "present" });
    expect(listRepos(ctx.db, p.id)).toMatchObject([{ path: repo, role: "main", defaultBranch: "main" }]);

    const call = runner.calls[0]!;
    expect(call.role).toBe("profiler");
    expect(call.cwd.startsWith(join(ctx.home, "worktrees", "shop"))).toBe(true);
    expect(call.artifactsDir).toBe(join(ctx.home, "projects", String(p.id)));
    expect(call.prompt).toContain(repo);
    // 片付け: 調査用のworktreeとブランチは残さない
    expect(existsSync(call.cwd)).toBe(false);
    expect(git(repo, "branch", "--list", "agent-crew/*")).toBe("");

    const dir = join(ctx.home, "projects", String(p.id));
    expect(JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"))).toMatchObject({ testInfra: "present" });
    expect(existsSync(join(dir, "profile.md"))).toBe(true);
    expect(readFileSync(join(dir, "decisions.md"), "utf8")).toContain("設計判断ログ");
  });

  it("git リポジトリのルート以外は登録できない", async () => {
    const ctx = testContext(new ScriptedRunner({}));
    const { root, repo } = makeRepo();
    await expect(registerProject(ctx, { name: "a", repoPath: root })).rejects.toThrow(/git リポジトリ/);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(repo, "sub"));
    await expect(registerProject(ctx, { name: "b", repoPath: join(repo, "sub") })).rejects.toThrow(/ルート/);
  });

  it("プロジェクト名はパスに使える文字だけ", async () => {
    const ctx = testContext(new ScriptedRunner({}));
    const { repo } = makeRepo();
    await expect(registerProject(ctx, { name: "../evil", repoPath: repo })).rejects.toThrow(/プロジェクト名/);
  });

  it("プロジェクト把握担当が失敗しても登録は残り、作り直せる", async () => {
    const runner = new ScriptedRunner({
      profiler: (spec, n) => (n === 0 ? { status: "failed", error: "boom" } : profiler("present")(spec, n)),
    });
    const ctx = testContext(runner);
    const { repo } = makeRepo();
    const r = await registerProject(ctx, { name: "shop", repoPath: repo });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("boom") });
    expect(getProjectByName(ctx.db, "shop")!.profileStatus).toBe("none");
    expect(git(repo, "branch", "--list", "agent-crew/*")).toBe("");
    const r2 = await reprofileProject(ctx, "shop");
    expect(r2.ok).toBe(true);
    expect(getProjectByName(ctx.db, "shop")!.profileStatus).toBe("draft");
  });
});

describe("approveProfile とテスト基盤のゲート", () => {
  async function registered(testInfra: "present" | "insufficient" | "none") {
    const ctx = testContext(new ScriptedRunner({ profiler: profiler(testInfra) }));
    const { repo } = makeRepo();
    await registerProject(ctx, { name: "shop", repoPath: repo });
    return ctx;
  }

  it("テスト基盤があれば承認するだけ", async () => {
    const ctx = await registered("present");
    const r = approveProfile(ctx, "shop");
    expect(r.testInfraTask).toBeUndefined();
    const p = getProjectByName(ctx.db, "shop")!;
    expect(p.profileStatus).toBe("approved");
    const t = createTask(ctx.db, { projectId: p.id, title: "x", body: "" });
    expect(testGateOpen(ctx.db, t.id)).toBe(true);
  });

  it.each(["none", "insufficient"] as const)("テスト基盤が %s なら整備タスクを自動で作り、通常タスクを止める", async (infra) => {
    const ctx = await registered(infra);
    const r = approveProfile(ctx, "shop");
    expect(r.testInfraTask).toMatchObject({ kind: "test_infra", state: "queued" });
    expect(r.testInfraTask!.body).toContain("notes");
    const p = getProjectByName(ctx.db, "shop")!;
    const normal = createTask(ctx.db, { projectId: p.id, title: "x", body: "" });
    expect(testGateOpen(ctx.db, normal.id)).toBe(false);
    expect(testGateOpen(ctx.db, r.testInfraTask!.id)).toBe(true);
    // 2回承認しても整備タスクは増えない
    approveProfile(ctx, "shop");
    expect(listTasks(ctx.db, { projectId: p.id }).filter((t) => t.kind === "test_infra")).toHaveLength(1);
  });

  it("人が例外を承認すれば通常タスクも開始できる", async () => {
    const ctx = await registered("none");
    approveProfile(ctx, "shop", { allowWithoutTests: true });
    const p = getProjectByName(ctx.db, "shop")!;
    const normal = createTask(ctx.db, { projectId: p.id, title: "x", body: "" });
    expect(testGateOpen(ctx.db, normal.id)).toBe(true);
  });

  it("プロファイルが無ければ承認できない", async () => {
    const ctx = testContext(new ScriptedRunner({ profiler: () => ({ status: "failed", error: "x" }) }));
    const { repo } = makeRepo();
    await registerProject(ctx, { name: "shop", repoPath: repo });
    expect(() => approveProfile(ctx, "shop")).toThrow(/プロファイル/);
  });
});
