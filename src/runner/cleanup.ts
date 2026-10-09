import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type KilledProcess = { pid: number; command: string };

/**
 * 役割の実行が残したプロセスを止める(自己適用で発見: QA が起動したサーバーを、サンドボックスの制限で止められずに残した)。
 * 対象は、作業ディレクトリ(worktree)の中を cwd にしていて、実行の開始(since)より後に起動されたプロセスだけ。
 * 実行の前から動いているもの(人の端末やエディタ)と、ほかの場所のプロセスには触らない。
 * lsof / ps が無い環境では何もしない。
 */
export async function cleanupStrayProcesses(dir: string, since: number): Promise<KilledProcess[]> {
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    return [];
  }
  const inside = (p: string) => p === root || p.startsWith(root + sep);

  let candidates: number[];
  try {
    // -d cwd: 各プロセスの作業ディレクトリだけを出す。-F pn: pid と名前を機械向けに
    const { stdout } = await run("lsof", ["-n", "-d", "cwd", "-F", "pn"], { maxBuffer: 16 * 1024 * 1024 });
    candidates = [];
    let pid = 0;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && pid && pid !== process.pid && inside(line.slice(1))) candidates.push(pid);
    }
  } catch {
    return [];
  }
  if (candidates.length === 0) return [];

  // 起動時刻(秒の精度)。実行の開始より後に起動されたものだけ
  let rows: { pid: number; started: number; command: string }[];
  try {
    const { stdout } = await run("ps", ["-o", "pid=,lstart=,command=", "-p", candidates.join(",")], { env: { ...process.env, LC_ALL: "C" } });
    rows = stdout
      .split("\n")
      .map((l) => /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(l))
      .flatMap((m) => (m ? [{ pid: Number(m[1]), started: Date.parse(m[2]!), command: m[3]! }] : []));
  } catch {
    return [];
  }
  const sinceSec = Math.floor(since / 1000) * 1000;
  const targets = rows.filter((r) => Number.isFinite(r.started) && r.started >= sinceSec);

  const killed: KilledProcess[] = [];
  for (const t of targets) {
    try {
      process.kill(t.pid, "SIGTERM");
      killed.push({ pid: t.pid, command: t.command });
    } catch {
      // すでに終わっている
    }
  }
  if (killed.length > 0) {
    await new Promise((r) => setTimeout(r, 1000));
    for (const k of killed) {
      try {
        process.kill(k.pid, "SIGKILL");
      } catch {
        // SIGTERM で終わった
      }
    }
  }
  return killed;
}
