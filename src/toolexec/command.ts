import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { buildAppSandboxProfile, defaultDenyRead } from "../browser/app.ts";
import type { Profile } from "../roles/schemas.ts";
import { buildAgentEnv } from "../runner/env.ts";
import type { AppContext } from "../orchestrator/context.ts";

/**
 * ツールが代わりにコマンドを実行する(設計メモ v0.15、フェーズ6)。
 * Flutter のテストは Claude のサンドボックスの中では動かないため(docs/safety.md 8章)、ツールの sandbox-exec で囲って実行する:
 * 書き込みは worktree・一時ディレクトリ・道具のキャッシュだけ、通信は 127.0.0.1 / localhost だけ、資格情報は読めない。
 * 実行するのはエージェントが書いたコード(テスト)なので、必ず sandbox-exec の中で動かす。
 */

export type CommandResult = { exitCode: number; timedOut: boolean; output: string; durationMs: number };

/** 出力は末尾だけ残す(報告とエージェントへの返答に使う) */
const OUTPUT_LIMIT = 64 * 1024;

export async function runSandboxedCommand(o: {
  cwd: string;
  command: string;
  writable: string[];
  tmpDir: string;
  denyRead?: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<CommandResult> {
  mkdirSync(o.tmpDir, { recursive: true });
  const started = Date.now();
  const profile = buildAppSandboxProfile({ writable: [...o.writable, o.tmpDir], denyRead: o.denyRead ?? [] });
  const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", o.command], {
    cwd: o.cwd,
    env: buildAgentEnv(process.env, { ...(o.env ?? {}), TMPDIR: o.tmpDir }),
    detached: true, // 時間切れのとき、プロセスグループごと止めるため
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (b: Buffer) => {
    output += b.toString("utf8");
    if (output.length > OUTPUT_LIMIT * 2) output = output.slice(-OUTPUT_LIMIT);
  };
  child.stdout!.on("data", append);
  child.stderr!.on("data", append);

  let timedOut = false;
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      // すでに終わった
    }
  };
  const stop = () => {
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), 2000).unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, o.timeoutMs ?? 15 * 60_000);
  o.signal?.addEventListener("abort", stop, { once: true });

  const exitCode = await new Promise<number>((resolve) => {
    child.on("error", (e) => {
      append(Buffer.from(`\n${e.message}\n`));
      resolve(127);
    });
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
  clearTimeout(timer);
  o.signal?.removeEventListener("abort", stop);
  return { exitCode, timedOut, output: output.slice(-OUTPUT_LIMIT), durationMs: Date.now() - started };
}

/** 種類ごとに、道具が書き込むキャッシュ(Flutter は SDK の bin/cache と、ホームの Dart / Flutter のキャッシュ) */
export function toolchainWritable(platform: NonNullable<Profile["platform"]>, o: { home: string; flutterRoot: string | null }): string[] {
  if (platform !== "flutter") return [];
  return [
    ...(o.flutterRoot ? [join(o.flutterRoot, "bin", "cache")] : []),
    ...[".pub-cache", ".dartServer", ".dart-tool", ".flutter", ".flutter-devtools"].map((d) => join(o.home, d)),
  ];
}

/** PATH の flutter から SDK のルートを求める(Homebrew のシンボリックリンクを解決する)。無ければ null */
export function findFlutterRoot(): string | null {
  try {
    const bin = execFileSync("/usr/bin/which", ["flutter"], { encoding: "utf8" }).trim();
    return bin ? dirname(dirname(realpathSync(bin))) : null;
  } catch {
    return null;
  }
}

export type ToolExecRequest = {
  cwd: string;
  command: string;
  platform: NonNullable<Profile["platform"]>;
  tmpDir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};
/** テストでは差し替える(AppContext.toolExec) */
export type ToolExecFn = (ctx: AppContext, req: ToolExecRequest) => Promise<CommandResult>;

export const defaultToolExec: ToolExecFn = (ctx, req) =>
  runSandboxedCommand({
    cwd: req.cwd,
    command: req.command,
    writable: [req.cwd, ...toolchainWritable(req.platform, { home: homedir(), flutterRoot: findFlutterRoot() })],
    tmpDir: req.tmpDir,
    denyRead: defaultDenyRead(homedir(), ctx.home),
    timeoutMs: req.timeoutMs,
    signal: req.signal,
  });
