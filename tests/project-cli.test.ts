import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRepo, tempDir } from "./helpers/gitrepo.ts";

const bin = new URL("../bin/agent-crew.js", import.meta.url).pathname;
const fake = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;

function cli(home: string, ...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [bin, ...args], { encoding: "utf8", env: { ...process.env, AGENT_CREW_HOME: home }, stdio: "pipe" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: err.stdout + err.stderr };
  }
}

describe("agent-crew project", () => {
  it("add → list → show。プロファイルが作れなければ理由を出し、承認は拒否する", () => {
    const home = tempDir("agent-crew-home-");
    // 偽の claude はプロファイルを返さないので、プロジェクト把握担当は失敗する
    writeFileSync(join(home, "config.json"), JSON.stringify({ claudePath: fake }));
    const { repo } = makeRepo();
    const add = cli(home, "project", "add", repo, "--name", "shop");
    expect(add.code).toBe(1);
    expect(add.out).toContain("登録しました");
    expect(add.out).toContain("プロファイルを作れませんでした");

    const list = cli(home, "project", "list");
    expect(list.out).toMatch(/shop\s+none\s+unknown/);

    const show = cli(home, "project", "show", "shop");
    expect(show.out).toContain(repo);

    const approve = cli(home, "project", "approve", "shop");
    expect(approve.code).toBe(1);
    expect(approve.out).toContain("プロファイルがありません");
  }, 60_000);
});
