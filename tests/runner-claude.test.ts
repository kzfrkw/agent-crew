import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeRunner } from "../src/runner/claude.ts";
import type { RunSpec } from "../src/runner/types.ts";
import { tempDir } from "./helpers/gitrepo.ts";

const fake = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;

function spec(scenario: string, over: Partial<RunSpec> = {}): RunSpec {
  const root = tempDir("agent-crew-run-");
  return {
    role: "implementer",
    cwd: root,
    runDir: join(root, "run"),
    artifactsDir: join(root, "artifacts"),
    prompt: `作業してください\nSCENARIO:${scenario}`,
    systemPromptAppend: "役割のプロンプト",
    model: "haiku",
    tools: ["Read"],
    write: "worktree",
    jsonSchema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
    timeoutSec: 30,
    maxBudgetUsd: 1,
    allowedDomains: [],
    ...over,
  };
}

const record = (s: RunSpec) => JSON.parse(readFileSync(join(s.cwd, ".fake-claude-record.json"), "utf8"));

describe("ClaudeRunner(偽の claude)", () => {
  const runner = new ClaudeRunner({ claudePath: fake, parentEnv: { ...process.env, GITHUB_TOKEN: "secret", ANTHROPIC_API_KEY: "sk" } });

  it("成功: 判定・費用・拒否の記録を返し、イベントを流す", async () => {
    const s = spec("ok");
    const events: string[] = [];
    const r = await runner.run(s, (e) => events.push(e.kind));
    expect(r).toMatchObject({
      status: "succeeded", structuredOutput: { verdict: "done", summary: "実装した" }, sessionId: "sess-1", costUsd: 0.25,
      permissionDenials: [{ tool: "Bash", input: { command: "git push" } }],
    });
    expect(events).toEqual(["init", "assistant_text", "tool_use", "tool_result", "rate_limit", "result"]);
  });

  it("プロンプトは標準入力で渡し、cwd は指定どおり、認証情報は渡さない", async () => {
    const s = spec("ok");
    await runner.run(s, () => {});
    const rec = record(s);
    expect(rec.prompt).toContain("作業してください");
    expect(rec.cwd).toBe(s.cwd);
    expect(rec.env.GITHUB_TOKEN).toBeUndefined();
    expect(rec.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(rec.env.AGENT_CREW_RUN).toBe("1");
    expect(rec.argv).toContain("--strict-mcp-config");
  });

  it("再現用に settings.json とコマンドを実行ディレクトリに残す", async () => {
    const s = spec("ok");
    await runner.run(s, () => {});
    const settings = JSON.parse(readFileSync(join(s.runDir, "settings.json"), "utf8"));
    expect(settings.disableAllHooks).toBe(true);
    expect(record(s).argv[record(s).argv.indexOf("--settings") + 1]).toBe(join(s.runDir, "settings.json"));
    expect(existsSync(join(s.runDir, "command.txt"))).toBe(true);
    expect(readFileSync(join(s.runDir, "prompt.md"), "utf8")).toContain("作業してください");
  });

  it("エラーの result は failed", async () => {
    const r = await runner.run(spec("error"), () => {});
    expect(r).toMatchObject({ status: "failed", error: expect.stringContaining("error_max_budget_usd") });
  });

  it("判定(structured_output)が無ければ failed", async () => {
    const r = await runner.run(spec("no-structured"), () => {});
    expect(r).toMatchObject({ status: "failed", error: expect.stringContaining("判定") });
  });

  it("プロセスが異常終了したら標準エラーを含めて failed", async () => {
    const r = await runner.run(spec("crash"), () => {});
    expect(r.status).toBe("failed");
    expect(r.error).toContain("boom");
  });

  it("時間の上限で SIGINT を送って止める", async () => {
    const t = Date.now();
    const r = await runner.run(spec("hang", { timeoutSec: 1 }), () => {});
    expect(r.status).toBe("timeout");
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it("SIGINT で止まらなければ SIGTERM で止める", async () => {
    const r2 = new ClaudeRunner({ claudePath: fake, parentEnv: process.env, killGraceMs: 300 });
    const r = await r2.run(spec("hang-ignore-sigint", { timeoutSec: 1 }), () => {});
    expect(r.status).toBe("timeout");
  });

  it("claude が見つからなければ failed", async () => {
    const r2 = new ClaudeRunner({ claudePath: "/no/such/claude", parentEnv: process.env });
    const r = await r2.run(spec("ok"), () => {});
    expect(r.status).toBe("failed");
  });
});

describe("パスの別名", () => {
  it("cwd と成果物ディレクトリの、指定どおりの表記と実体の表記の両方に許可を出す", async () => {
    const { symlinkSync } = await import("node:fs");
    const s = spec("ok");
    const link = join(tempDir("agent-crew-link-"), "alias");
    symlinkSync(s.cwd, link);
    await new ClaudeRunner({ claudePath: fake, parentEnv: process.env }).run({ ...s, cwd: link }, () => {});
    const settings = JSON.parse(readFileSync(join(s.runDir, "settings.json"), "utf8"));
    expect(settings.permissions.allow).toEqual(expect.arrayContaining([`Edit(/${link}/**)`, `Edit(/${s.cwd}/**)`]));
  });
});
