import { createTask, getProjectByName, type Task } from "../../src/db/store.ts";
import type { AppContext } from "../../src/orchestrator/context.ts";
import { approveProfile, registerProject } from "../../src/orchestrator/projects.ts";
import type { Profile } from "../../src/roles/schemas.ts";
import { makeRepo } from "./gitrepo.ts";
import { ScriptedRunner, writeArtifact } from "./scripted-runner.ts";

export const PROFILE: Profile = {
  testInfra: "present",
  testInfraNotes: "node --test",
  conventions: "ESM",
  qaMethod: "curl",
  commands: { install: null, build: null, test: "npm test", start: "npm start" },
  startUrl: "http://127.0.0.1:3000/",
};

/** 登録・プロファイル承認済みのプロジェクト(リポジトリは一時的なgitリポジトリ) */
export async function approvedProject(ctx: AppContext, profile: Partial<Profile> = {}) {
  const { repo, remote } = makeRepo();
  const saved = ctx.runner;
  ctx.runner = new ScriptedRunner({
    profiler: (spec) => {
      writeArtifact(spec, "profile.md", "ready");
      return { structuredOutput: { verdict: "ready", summary: "s", profile: { ...PROFILE, ...profile } } };
    },
  });
  await registerProject(ctx, { name: "shop", repoPath: repo });
  ctx.runner = saved;
  const r = approveProfile(ctx, "shop");
  return { project: getProjectByName(ctx.db, "shop")!, repo, remote, testInfraTask: r.testInfraTask };
}

export function newTask(ctx: AppContext, projectId: number, title = "在庫が0のアイテムを除外する", body = "GET /api/items で在庫0を返さない"): Task {
  return createTask(ctx.db, { projectId, title, body });
}
