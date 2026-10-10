import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectByName, getRepoProfile, listRepos } from "../src/db/store.ts";
import { projectDir } from "../src/orchestrator/paths.ts";
import { addRepository, approveProfile, registerProject, resolveServiceEnv, setProfileCommands, setRepoWiring } from "../src/orchestrator/projects.ts";
import type { Profile } from "../src/roles/schemas.ts";
import { testContext } from "./helpers/context.ts";
import { makeRepo } from "./helpers/gitrepo.ts";
import { PROFILE } from "./helpers/project.ts";
import { ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";

/** 調べたリポジトリ(worktree の最後の名前 = 役目)ごとに違うプロファイルを返すプロジェクト把握担当 */
const profiler =
  (byRole: Record<string, Partial<Profile> | "fail">): Script =>
  (spec) => {
    const role = spec.cwd.split("/").at(-1)!;
    const p = byRole[role];
    if (p === "fail") return { status: "failed", error: "調べられませんでした" };
    writeArtifact(spec, "profile.md", "ready", `# ${role}`);
    return { structuredOutput: { verdict: "ready", summary: role, profile: { ...PROFILE, ...p } } };
  };

async function twoRepos(byRole: Record<string, Partial<Profile> | "fail">) {
  const runner = new ScriptedRunner({ profiler: profiler(byRole) });
  const ctx = testContext(runner);
  const front = makeRepo().repo;
  const back = makeRepo().repo;
  await registerProject(ctx, { name: "shop", repoPath: front, role: "frontend" });
  const r = await addRepository(ctx, { name: "shop", repoPath: back, role: "backend" });
  return { ctx, runner, front, back, r };
}

describe("複数リポジトリの登録(フェーズ5)", () => {
  it("リポジトリを追加すると、そのリポジトリをプロジェクト把握担当が調べる。プロファイルはリポジトリごとに残る", async () => {
    const { ctx, runner, back, r } = await twoRepos({
      frontend: { startUrl: "http://127.0.0.1:3000/" },
      backend: { startUrl: "http://127.0.0.1:3001/", commands: { install: null, build: null, test: "npm test", start: "node api.js" } },
    });
    expect(r.ok).toBe(true);
    const project = getProjectByName(ctx.db, "shop")!;
    const repos = listRepos(ctx.db, project.id);
    expect(repos.map((x) => [x.role, x.path])).toEqual([
      ["frontend", expect.any(String)],
      ["backend", back],
    ]);
    expect(runner.calls.map((c) => c.cwd.split("/").at(-1))).toEqual(["frontend", "backend"]);
    expect((getRepoProfile(ctx.db, repos[1]!.id) as Profile).commands.start).toBe("node api.js");
    // 2つ目以降のリポジトリのプロファイルの文書は、役目ごとの場所に置く
    expect(existsSync(join(projectDir(ctx.home, project.id), "repos", "backend", "profile.md"))).toBe(true);
    expect(project.profileStatus).toBe("draft");
  });

  it("プロジェクトのテスト基盤は、全リポジトリのうち最も弱いもの", async () => {
    const { ctx } = await twoRepos({ frontend: { testInfra: "present" }, backend: { testInfra: "insufficient" } });
    expect(getProjectByName(ctx.db, "shop")!.testInfra).toBe("insufficient");
  });

  it("全リポジトリのプロファイルがそろうまで承認できない", async () => {
    const { ctx, r } = await twoRepos({ frontend: {}, backend: "fail" });
    expect(r.ok).toBe(false);
    expect(() => approveProfile(ctx, "shop")).toThrow(/backend/);
  });

  it("役目は英数字・-・_ で、プロジェクトの中で重ならない", async () => {
    const { ctx } = await twoRepos({ frontend: {}, backend: {} });
    await expect(addRepository(ctx, { name: "shop", repoPath: makeRepo().repo, role: "backend" })).rejects.toThrow(/すでに/);
    await expect(addRepository(ctx, { name: "shop", repoPath: makeRepo().repo, role: "バック" })).rejects.toThrow(/役目/);
  });

  it("コマンドの手直しは役目を指定できる(既定は1つ目)", async () => {
    const { ctx } = await twoRepos({ frontend: {}, backend: {} });
    setProfileCommands(ctx, "shop", { start: "node api.js --port 4001" }, "backend");
    const repos = listRepos(ctx.db, getProjectByName(ctx.db, "shop")!.id);
    expect((getRepoProfile(ctx.db, repos[1]!.id) as Profile).commands.start).toBe("node api.js --port 4001");
    expect((getRepoProfile(ctx.db, repos[0]!.id) as Profile).commands.start).toBe(PROFILE.commands.start);
  });
});

describe("起動のつなぎ方(環境変数)", () => {
  it("{url:<役目>} / {port:<役目>} を、そのリポジトリの確認 URL / ポートに置き換える", async () => {
    const { ctx } = await twoRepos({ frontend: { startUrl: "http://127.0.0.1:3000/" }, backend: { startUrl: "http://127.0.0.1:3001/api" } });
    setRepoWiring(ctx, "shop", "frontend", { API_URL: "{url:backend}", API_PORT: "{port:backend}", MODE: "dev" });
    const project = getProjectByName(ctx.db, "shop")!;
    expect(resolveServiceEnv(ctx.db, project.id, "frontend")).toEqual({ API_URL: "http://127.0.0.1:3001/api", API_PORT: "3001", MODE: "dev" });
    expect(resolveServiceEnv(ctx.db, project.id, "backend")).toEqual({});
  });

  it("{origin:<役目>} は、確認 URL のパスを除いたもの(API の基点に使う)", async () => {
    const { ctx } = await twoRepos({ frontend: {}, backend: { startUrl: "http://127.0.0.1:3001/api/orders" } });
    setRepoWiring(ctx, "shop", "frontend", { API_BASE: "{origin:backend}", API_URL: "{origin:backend}/api" });
    const project = getProjectByName(ctx.db, "shop")!;
    expect(resolveServiceEnv(ctx.db, project.id, "frontend")).toEqual({ API_BASE: "http://127.0.0.1:3001", API_URL: "http://127.0.0.1:3001/api" });
    expect(() => setRepoWiring(ctx, "shop", "frontend", { A: "{origin:db}" })).toThrow(/db/);
  });

  it("知らない役目・確認 URL の無いリポジトリを指すものは設定できない", async () => {
    const { ctx } = await twoRepos({ frontend: {}, backend: { startUrl: null } });
    expect(() => setRepoWiring(ctx, "shop", "frontend", { API_URL: "{url:db}" })).toThrow(/db/);
    expect(() => setRepoWiring(ctx, "shop", "frontend", { API_URL: "{url:backend}" })).toThrow(/確認 URL/);
    expect(() => setRepoWiring(ctx, "shop", "nope", { A: "1" })).toThrow(/nope/);
  });
});
