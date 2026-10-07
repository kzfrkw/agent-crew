import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRoles, defaultRolesDir, verdictSchemaFor, applyRoleOverrides } from "../src/roles/roles.ts";
import { ProfileSchema } from "../src/roles/schemas.ts";
import { tempDir } from "./helpers/gitrepo.ts";

function rolesDir(files: Record<string, string>): string {
  const dir = tempDir("agent-crew-roles-");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const valid = `---
name: planner
description: 計画を作る
model: opus
effort: high
tools: [Read, Grep, Glob, Write]
permissions:
  write: artifacts
verdicts: [ready, need_human]
output: plan.md
timeoutSec: 600
maxBudgetUsd: 2
---
# プランナー
計画を書く。
`;

describe("loadRoles", () => {
  it("frontmatter と本文を読み、共通ルールを末尾に加える", () => {
    const roles = loadRoles(rolesDir({ "planner.md": valid, "_common.md": "共通ルール: 要約と判定だけを返す" }));
    const p = roles.get("planner")!;
    expect(p).toMatchObject({
      name: "planner", model: "opus", effort: "high", tools: ["Read", "Grep", "Glob", "Write"],
      permissions: { write: "artifacts", bashWritesWorktree: false, localServer: false },
      verdicts: ["ready", "need_human"], output: "plan.md", timeoutSec: 600, maxBudgetUsd: 2, resume: false,
    });
    expect(p.prompt).toContain("計画を書く。");
    expect(p.prompt.trim().endsWith("共通ルール: 要約と判定だけを返す")).toBe(true);
  });

  it("ファイル名と name が違えば拒否する", () => {
    expect(() => loadRoles(rolesDir({ "reviewer.md": valid }))).toThrow(/reviewer\.md/);
  });

  it("不正な書き込み範囲や空の判定は拒否する", () => {
    expect(() => loadRoles(rolesDir({ "planner.md": valid.replace("write: artifacts", "write: everything") }))).toThrow(/planner\.md/);
    expect(() => loadRoles(rolesDir({ "planner.md": valid.replace("verdicts: [ready, need_human]", "verdicts: []") }))).toThrow();
  });

  it("frontmatter が無ければ拒否する", () => {
    expect(() => loadRoles(rolesDir({ "planner.md": "# no frontmatter" }))).toThrow(/frontmatter/);
  });

  it("設定ファイルでモデルと effort を上書きできる", () => {
    const roles = applyRoleOverrides(loadRoles(rolesDir({ "planner.md": valid })), { planner: { model: "haiku" } });
    expect(roles.get("planner")).toMatchObject({ model: "haiku", effort: "high" });
  });
});

describe("同梱の役割定義", () => {
  const roles = loadRoles(defaultRolesDir());

  it("フェーズ1の役割がそろっている", () => {
    expect([...roles.keys()].sort()).toEqual(["implementer", "integrator", "planner", "profiler", "qa", "reviewer", "verifier"]);
  });

  it("判定の列挙値が状態遷移と一致している", () => {
    expect(roles.get("planner")!.verdicts).toEqual(["ready", "need_human"]);
    expect(roles.get("implementer")!.verdicts).toEqual(["done", "blocked", "need_human"]);
    expect(roles.get("reviewer")!.verdicts).toEqual(["approve", "changes_requested", "need_human"]);
    expect(roles.get("qa")!.verdicts).toEqual(["passed", "failed", "need_human"]);
    expect(roles.get("integrator")!.verdicts).toEqual(["done", "blocked"]);
    expect(roles.get("profiler")!.verdicts).toEqual(["ready", "need_human"]);
  });

  it("書き込み範囲: worktree に書けるのは実装者だけ", () => {
    const writers = [...roles.values()].filter((r) => r.permissions.write === "worktree").map((r) => r.name);
    expect(writers).toEqual(["implementer"]);
  });

  it("全役割の本文に共通ルールが入っている", () => {
    for (const r of roles.values()) expect(r.prompt).toContain("要約");
  });
});

describe("verdictSchemaFor", () => {
  it("判定の列挙値と要約を必須にする", () => {
    const roles = loadRoles(defaultRolesDir());
    const s = verdictSchemaFor(roles.get("reviewer")!) as any;
    expect(s.properties.verdict.enum).toEqual(["approve", "changes_requested", "need_human"]);
    expect(s.required).toEqual(expect.arrayContaining(["verdict", "summary"]));
  });

  it("プロジェクト把握担当はプロファイルも返す", () => {
    const roles = loadRoles(defaultRolesDir());
    const s = verdictSchemaFor(roles.get("profiler")!) as any;
    expect(s.required).toContain("profile");
    expect(s.properties.profile.properties.testInfra.enum).toEqual(["present", "insufficient", "none"]);
  });

  it("プロファイルのスキーマで検証できる", () => {
    expect(ProfileSchema.safeParse({
      testInfra: "present", testInfraNotes: "vitest", conventions: "", qaMethod: "curl",
      commands: { install: "npm ci", test: "npm test", build: null, start: "npm start" }, startUrl: "http://127.0.0.1:3000/",
    }).success).toBe(true);
    expect(ProfileSchema.safeParse({ testInfra: "maybe" }).success).toBe(false);
  });
});

describe("agent-crew roles", () => {
  it("役割・モデル・書き込み範囲・判定を一覧する(設定の上書きを反映)", async () => {
    const { execFileSync } = await import("node:child_process");
    const home = tempDir("agent-crew-home-");
    writeFileSync(join(home, "config.json"), JSON.stringify({ roles: { planner: { model: "sonnet" } } }));
    const out = execFileSync(process.execPath, [new URL("../bin/agent-crew.js", import.meta.url).pathname, "roles"], {
      encoding: "utf8", env: { ...process.env, AGENT_CREW_HOME: home },
    });
    expect(out).toMatch(/planner\s+sonnet\s+artifacts\s+ready\/need_human/);
    expect(out).toMatch(/implementer\s+sonnet\s+worktree/);
  });
});

describe("claude の --json-schema が受け付ける形", () => {
  it("$schema(draft 2020-12 の宣言)を含めない", () => {
    const roles = loadRoles(defaultRolesDir());
    for (const r of roles.values()) expect(JSON.stringify(verdictSchemaFor(r))).not.toContain("$schema");
  });
});
