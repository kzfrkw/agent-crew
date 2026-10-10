import { spawn } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupStrayProcesses } from "../src/runner/cleanup.ts";
import { inAgentSandbox } from "./helpers/env.ts";
import { tempDir } from "./helpers/gitrepo.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 作業ディレクトリで、親から切り離して動き続けるプロセス(QA が残したサーバーの代わり) */
function stray(cwd: string): number {
  const child = spawn("sleep", ["60"], { cwd, detached: true, stdio: "ignore" });
  child.unref();
  return child.pid!;
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(inAgentSandbox)("役割の実行の後片付け(自己適用で発見)", () => {
  it("作業ディレクトリの中で、実行の開始より後に起動されたプロセスを止める", async () => {
    const dir = tempDir("agent-crew-cleanup-");
    const since = Date.now();
    await sleepMs(1100); // ps の起動時刻は秒単位
    const pid = stray(dir);
    await sleepMs(300);
    const killed = await cleanupStrayProcesses(dir, since);
    expect(killed.map((k) => k.pid)).toContain(pid);
    expect(killed.find((k) => k.pid === pid)!.command).toContain("sleep");
    await sleepMs(300);
    expect(alive(pid)).toBe(false);
  });

  it("実行の前から動いているプロセス(人の端末など)と、ほかの場所のプロセスは止めない", async () => {
    const dir = tempDir("agent-crew-cleanup-");
    const other = tempDir("agent-crew-other-");
    const before = stray(dir);
    await sleepMs(1100);
    const since = Date.now();
    await sleepMs(1100);
    const elsewhere = stray(other);
    await sleepMs(300);
    try {
      const killed = await cleanupStrayProcesses(dir, since);
      expect(killed).toEqual([]);
      expect(alive(before)).toBe(true);
      expect(alive(elsewhere)).toBe(true);
    } finally {
      process.kill(before);
      process.kill(elsewhere);
    }
  });
});

describe("後片付けが止まったままにならない", () => {
  it("lsof が応答しないときは、上限の時間で諦めて何もしない(応答しないプロセスを調べると lsof が止まることがある)", async () => {
    const dir = tempDir("agent-crew-cleanup-");
    const bin = tempDir("agent-crew-fakebin-");
    writeFileSync(join(bin, "lsof"), `#!/bin/sh\ntouch "${join(bin, "called")}"\nexec sleep 30\n`);
    chmodSync(join(bin, "lsof"), 0o755);
    const startedAt = Date.now();
    // 直近に起動したプロセスがあるようにする(無ければ lsof まで進まない)
    const other = spawn("sleep", ["3"], { stdio: "ignore" });
    await sleepMs(100);
    const killed = await cleanupStrayProcesses(dir, startedAt - 5000, { timeoutMs: 500, path: `${bin}:${process.env.PATH}` });
    expect(existsSync(join(bin, "called"))).toBe(true);
    expect(killed).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    other.kill();
  });
});
