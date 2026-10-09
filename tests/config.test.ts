import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataHome, loadConfig, DEFAULT_CONFIG } from "../src/config/config.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "agent-crew-config-"));

describe("dataHome", () => {
  it("AGENT_CREW_HOME があればそれを使う", () => {
    expect(dataHome({ AGENT_CREW_HOME: "/x/y" })).toBe("/x/y");
  });
  it("無ければ ~/.agent-team", () => {
    expect(dataHome({})).toBe(join(homedir(), ".agent-team"));
  });
});

describe("loadConfig", () => {
  it("config.json が無ければ既定値", () => {
    expect(loadConfig(tmp())).toEqual(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.concurrency).toBe(1);
  });

  it("ファイルの値を既定値に重ねる", () => {
    const home = tmp();
    writeFileSync(join(home, "config.json"), JSON.stringify({ concurrency: 2, limits: { runTimeoutSec: 60 } }));
    const c = loadConfig(home);
    expect(c.concurrency).toBe(2);
    expect(c.limits.runTimeoutSec).toBe(60);
    expect(c.limits.maxReviewRounds).toBe(DEFAULT_CONFIG.limits.maxReviewRounds);
  });

  it("Must 指摘の監査は既定でオン。設定で止められる", () => {
    expect(DEFAULT_CONFIG.review.audit).toBe(true);
    const home = tmp();
    writeFileSync(join(home, "config.json"), JSON.stringify({ review: { audit: false } }));
    expect(loadConfig(home).review.audit).toBe(false);
  });

  it("同時実行数は2まで", () => {
    const home = tmp();
    writeFileSync(join(home, "config.json"), JSON.stringify({ concurrency: 3 }));
    expect(() => loadConfig(home)).toThrow(/concurrency/);
  });

  it("壊れたJSONはパス付きで失敗する", () => {
    const home = tmp();
    writeFileSync(join(home, "config.json"), "{ broken");
    expect(() => loadConfig(home)).toThrow(join(home, "config.json"));
  });
});
