import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, getProjectByName, listRepos, listTaskRepos } from "../src/db/store.ts";
import { ensureWorktrees } from "../src/orchestrator/engine.ts";
import { addRepository, registerProject, setProfileCommands, setRepoWiring } from "../src/orchestrator/projects.ts";
import { captureTaskScreens, pickScreenTarget } from "../src/orchestrator/screens.ts";
import { findChrome } from "../src/browser/chrome.ts";
import { testContext } from "./helpers/context.ts";
import { inAgentSandbox } from "./helpers/env.ts";
import { makeRepo, tempDir } from "./helpers/gitrepo.ts";
import { PROFILE } from "./helpers/project.ts";
import { ScriptedRunner, writeArtifact } from "./helpers/scripted-runner.ts";

const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && !inAgentSandbox && !!findChrome();

async function setup(roles: string[]) {
  const runner = new ScriptedRunner({
    profiler: (spec) => {
      writeArtifact(spec, "profile.md", "ready");
      return { structuredOutput: { verdict: "ready", summary: "s", profile: PROFILE } };
    },
  });
  const ctx = testContext(runner);
  const [first, ...rest] = roles;
  await registerProject(ctx, { name: "shop", repoPath: makeRepo().repo, role: first });
  for (const r of rest) await addRepository(ctx, { name: "shop", repoPath: makeRepo().repo, role: r });
  return { ctx, project: getProjectByName(ctx.db, "shop")! };
}

describe("撮る相手(複数リポジトリ)", () => {
  it("確認 URL のあるリポジトリのうち、計画の順で最後のもの(API → 画面なら画面)。無ければ登録の順で確認 URL のあるもの", async () => {
    const { ctx, project } = await setup(["frontend", "backend"]);
    const t = createTask(ctx.db, { projectId: project.id, title: "t", body: "" });
    expect(pickScreenTarget(ctx, { ...t, repos: ["backend", "frontend"] })?.role).toBe("frontend");
    setProfileCommands(ctx, "shop", { startUrl: "-" }, "frontend");
    expect(pickScreenTarget(ctx, { ...t, repos: ["backend", "frontend"] })?.role).toBe("backend");
  });
});

describe("Flutter のリポジトリの撮影(フェーズ6)", () => {
  it("撮る相手が Flutter なら、iOS シミュレータの撮影に回す(screens_test.dart が無ければその理由で失敗する)", async () => {
    const { ctx, project } = await setup(["app"]);
    setProfileCommands(ctx, "shop", { platform: "flutter", start: "-", startUrl: "-", test: "flutter test" });
    const t = createTask(ctx.db, { projectId: project.id, title: "t", body: "" });
    ensureWorktrees(ctx, t);
    const wt = listTaskRepos(ctx.db, t.id)[0]!.worktreePath;
    expect(pickScreenTarget(ctx, t)).toMatchObject({ role: "app", platform: "flutter" });
    await expect(captureTaskScreens(ctx, t, { worktree: wt, outDir: tempDir("agent-crew-shots-"), screens: [{ path: "s1" }] })).rejects.toThrow(/screens_test\.dart/);
  });
});

describe("ネイティブ iOS のリポジトリの撮影(6b)", () => {
  it("撮る相手がネイティブ iOS なら XCUITest の撮影に回す(撮影の UI テストが無ければその理由で失敗する)", async () => {
    const { ctx, project } = await setup(["app"]);
    setProfileCommands(ctx, "shop", { platform: "ios", start: "-", startUrl: "-", test: "xcodebuild test -scheme Orders -destination 'platform=iOS Simulator,id={simulator}'", screens: "-" });
    const t = createTask(ctx.db, { projectId: project.id, title: "t", body: "" });
    ensureWorktrees(ctx, t);
    const wt = listTaskRepos(ctx.db, t.id)[0]!.worktreePath;
    expect(pickScreenTarget(ctx, t)).toMatchObject({ role: "app", platform: "ios" });
    await expect(captureTaskScreens(ctx, t, { worktree: wt, outDir: tempDir("agent-crew-shots-"), screens: [{ path: "s1" }] })).rejects.toThrow(/撮影の UI テスト/);
  });
});

describe.skipIf(!mac)("複数リポジトリの撮影(macOS、Chrome があるとき)", () => {
  it("関係するリポジトリを登録の順に起動し、つなぎ方の環境変数を渡して、画面のリポジトリから撮る", async () => {
    const { ctx, project } = await setup(["backend", "frontend"]);
    const repos = listRepos(ctx.db, project.id);
    const t = createTask(ctx.db, { projectId: project.id, title: "t", body: "" });
    ensureWorktrees(ctx, { ...t, repos: ["backend", "frontend"] }, ["backend", "frontend"]);
    const wt = (role: string) => listTaskRepos(ctx.db, t.id).find((x) => x.repoId === repos.find((r) => r.role === role)!.id)!.worktreePath;
    writeFileSync(join(wt("backend"), "api.mjs"), `import { createServer } from "node:http";\ncreateServer((_, res) => res.end(JSON.stringify({ items: 3 }))).listen(4381, "127.0.0.1");\n`);
    writeFileSync(
      join(wt("frontend"), "web.mjs"),
      `import { createServer } from "node:http";\ncreateServer(async (_, res) => { const d = await (await fetch(process.env.API_URL)).json(); res.end("<!doctype html><h1>items=" + d.items + "</h1>"); }).listen(4382, "127.0.0.1");\n`,
    );
    setProfileCommands(ctx, "shop", { start: "node api.mjs", startUrl: "http://127.0.0.1:4381/" }, "backend");
    setProfileCommands(ctx, "shop", { start: "node web.mjs", startUrl: "http://127.0.0.1:4382/" }, "frontend");
    setRepoWiring(ctx, "shop", "frontend", { API_URL: "{url:backend}" });

    const out = tempDir("agent-crew-shots-");
    const shots = await captureTaskScreens(ctx, { ...t, repos: ["backend", "frontend"] }, { worktree: wt("frontend"), outDir: out, screens: [{ path: "/" }] });
    expect(shots.filter((s) => s.error)).toEqual([]);
    expect(statSync(join(out, shots[0]!.file)).size).toBeGreaterThan(1000);
    // 撮影の後は両方とも止まっている
    await expect(fetch("http://127.0.0.1:4381/")).rejects.toThrow();
    await expect(fetch("http://127.0.0.1:4382/")).rejects.toThrow();
  }, 90_000);
});
