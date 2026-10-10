import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { buildAgentEnv } from "../runner/env.ts";

/**
 * 撮影のために、エージェントが書いたアプリをツールが起動する(設計メモ v0.13、4c)。
 * アプリはエージェントのコードなので、ツールが作る sandbox-exec のプロファイルの中で動かす:
 * 書き込みは worktree と撮影用の一時ディレクトリだけ、通信は 127.0.0.1 / localhost だけ、資格情報は読めない。
 */

export type SandboxedApp = { log: () => string; stop: () => Promise<void> };

const SAFE_PATH = /^[^"\\\n\r\0]+$/;

/** 実体のパスと指定どおりのパスの両方(macOS の /var → /private/var など。サンドボックスは実体のパスで照合する) */
function variants(path: string): string[] {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // まだ無いパスはそのまま
  }
  return [...new Set([path, real])];
}

export function buildAppSandboxProfile(o: { writable: string[]; denyRead: string[] }): string {
  for (const p of [...o.writable, ...o.denyRead]) if (!SAFE_PATH.test(p)) throw new Error(`サンドボックスのプロファイルに使えないパスです: ${p}`);
  const sub = (p: string) => `(subpath "${p}")`;
  return [
    "(version 1)",
    "(allow default)",
    // 書き込みは指定の場所と、端末・/dev の基本だけ
    "(deny file-write*)",
    `(allow file-write* ${o.writable.flatMap(variants).map(sub).join(" ")} (literal "/dev/null") (literal "/dev/zero") (subpath "/dev/fd") (regex #"^/dev/tty") (literal "/dev/dtracehelper"))`,
    // 通信は 127.0.0.1 / localhost だけ。待ち受け・受信は localhost で、外向きの接続は相手が localhost のときだけ
    // (network* に local ip を許すと、外向きの接続まで通ってしまう。テストで判明)
    "(deny network*)",
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    ...o.denyRead.flatMap(variants).map((p) => `(deny file-read* ${sub(p)})`),
  ].join("\n");
}

/** ツールの外に漏らしてはいけない場所(アプリから読めないようにする) */
export function defaultDenyRead(home: string, dataHome: string): string[] {
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".config", "gh"),
    join(home, ".netrc"),
    join(home, ".npmrc"),
    join(dataHome, "config.json"),
    join(dataHome, "agent-crew.db"),
  ];
}

export async function startSandboxedApp(o: {
  cwd: string;
  command: string;
  url: string;
  writable: string[];
  tmpDir: string;
  denyRead?: string[];
  timeoutMs?: number;
  /** 追加の環境変数(複数リポジトリのつなぎ方など) */
  env?: Record<string, string>;
  /** false なら URL への応答を待たない(確認 URL の無いリポジトリ) */
  waitForUrl?: boolean;
}): Promise<SandboxedApp> {
  mkdirSync(o.tmpDir, { recursive: true });
  const logPath = join(o.tmpDir, "app.log");
  const logFd = openSync(logPath, "a");
  const profile = buildAppSandboxProfile({ writable: [...o.writable, o.tmpDir], denyRead: o.denyRead ?? [] });
  const child: ChildProcess = spawn("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", o.command], {
    cwd: o.cwd,
    env: buildAgentEnv(process.env, { ...(o.env ?? {}), TMPDIR: o.tmpDir }),
    detached: true, // プロセスグループごと止めるため
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  const log = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
  let exited: number | null = null;
  child.on("exit", (code) => (exited = code ?? -1));

  const stop = async () => {
    if (exited !== null || child.pid === undefined) return;
    const group = -child.pid;
    try {
      process.kill(group, "SIGTERM");
    } catch {
      return;
    }
    for (let i = 0; i < 30 && exited === null; i++) await new Promise((r) => setTimeout(r, 100));
    if (exited === null) {
      try {
        process.kill(group, "SIGKILL");
      } catch {
        // すでに終わった
      }
    }
  };

  if (o.waitForUrl === false) {
    await new Promise((r) => setTimeout(r, 1000));
    if (exited !== null) throw new Error(`アプリが起動前に終了しました(終了コード ${exited}):\n${log().slice(-2000)}`);
    return { log, stop };
  }
  const until = Date.now() + (o.timeoutMs ?? 60_000);
  for (;;) {
    if (exited !== null) throw new Error(`アプリが起動前に終了しました(終了コード ${exited}):\n${log().slice(-2000)}`);
    try {
      await fetch(o.url, { signal: AbortSignal.timeout(2000) });
      return { log, stop };
    } catch {
      // まだ待ち受けていない
    }
    if (Date.now() > until) {
      await stop();
      throw new Error(`アプリが ${o.url} で応答しませんでした:\n${log().slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}
