import { spawn } from "node:child_process";
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
