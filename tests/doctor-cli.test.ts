import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const bin = new URL("../bin/agent-crew.js", import.meta.url).pathname;

describe("agent-crew doctor --json", () => {
  it("チェック結果をJSONで出す", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-crew-doctor-"));
    let out: string;
    try {
      out = execFileSync(process.execPath, [bin, "doctor", "--json"], {
        encoding: "utf8",
        env: { ...process.env, AGENT_CREW_HOME: home },
      });
    } catch (e) {
      out = (e as { stdout: string }).stdout; // エラーがあると終了コード1だが出力はある
    }
    const results = JSON.parse(out) as { id: string; level: string }[];
    const ids = results.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["node", "git", "claude", "auth", "anthropic-api-key", "sandbox", "config"]));
  }, 30_000);
});
