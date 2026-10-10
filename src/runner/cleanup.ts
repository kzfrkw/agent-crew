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

  // 1. 実行の開始より後に起動したプロセスだけに絞る(ps は軽い。lsof で全プロセスを調べると、負荷が高いとき数秒かかる)
  const sinceSec = Math.floor(since / 1000) * 1000;
  let recent: { pid: number; command: string }[];
  try {
    const { stdout } = await run("ps", ["-A", "-o", "pid=,lstart=,command="], { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 16 * 1024 * 1024 });
    recent = stdout
      .split("\n")
      .map((l) => /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(l))
      .flatMap((m) => (m ? [{ pid: Number(m[1]), started: Date.parse(m[2]!), command: m[3]! }] : []))
      .filter((r) => r.pid !== process.pid && Number.isFinite(r.started) && r.started >= sinceSec)
      .map(({ pid, command }) => ({ pid, command }));
  } catch {
    return [];
  }
  if (recent.length === 0) return [];

  // 2. そのうち、作業ディレクトリ(cwd)が dir の中にあるもの
  const insidePids = new Set<number>();
  try {
    const { stdout } = await run("lsof", ["-n", "-a", "-d", "cwd", "-p", recent.map((r) => r.pid).join(","), "-F", "pn"], { maxBuffer: 16 * 1024 * 1024 });
    let pid = 0;
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && pid && inside(line.slice(1))) insidePids.add(pid);
    }
  } catch (e) {
    // lsof は、調べたプロセスの一部がすでに終わっていると終了コード 1 を返す。出力は使える
    const out = (e as { stdout?: string }).stdout ?? "";
    let pid = 0;
    for (const line of out.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && pid && inside(line.slice(1))) insidePids.add(pid);
    }
  }
  const targets = recent.filter((r) => insidePids.has(r.pid));

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
