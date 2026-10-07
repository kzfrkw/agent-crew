import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { configPath, dataHome, loadConfig } from "../config/config.ts";
import { runChecks, type CheckResult, type Probe } from "./checks.ts";

function systemProbe(claudePath: string): Probe {
  return {
    env: process.env,
    nodeVersion: process.versions.node,
    platform: process.platform,
    claudePath,
    exists: existsSync,
    run(cmd, args) {
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000 });
      return { ok: r.status === 0, stdout: r.stdout ?? "" };
    },
  };
}

export function doctor(): CheckResult[] {
  const home = dataHome();
  let claudePath = "claude";
  let configResult: CheckResult;
  try {
    const config = loadConfig(home);
    claudePath = config.claudePath;
    configResult = {
      id: "config",
      level: "ok",
      message: existsSync(configPath(home)) ? `設定: ${configPath(home)}` : `設定ファイルなし(既定値を使用): ${configPath(home)}`,
    };
  } catch (e) {
    configResult = { id: "config", level: "error", message: (e as Error).message };
  }
  return [configResult, ...runChecks(systemProbe(claudePath))];
}

const MARK = { ok: "✓", info: "i", warn: "!", error: "✗" } as const;

export function formatResults(results: CheckResult[]): string {
  return results.map((r) => `${MARK[r.level]} [${r.id}] ${r.message}`).join("\n");
}
