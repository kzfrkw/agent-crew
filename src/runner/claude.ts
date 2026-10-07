import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { buildClaudeArgs } from "./args.ts";
import { buildAgentEnv } from "./env.ts";
import { buildRunSettings } from "./policy.ts";
import { StreamCollector } from "./stream.ts";
import type { RunEvent, RunResult, RunSpec, Runner } from "./types.ts";

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** claude -p(ヘッドレス実行)でエージェントを動かす */
export class ClaudeRunner implements Runner {
  private readonly claudePath: string;
  private readonly parentEnv: Record<string, string | undefined>;
  private readonly killGraceMs: number;

  constructor(o: { claudePath: string; parentEnv?: Record<string, string | undefined>; killGraceMs?: number }) {
    this.claudePath = o.claudePath;
    this.parentEnv = o.parentEnv ?? process.env;
    this.killGraceMs = o.killGraceMs ?? 10_000;
  }

  run(spec: RunSpec, onEvent: (e: RunEvent) => void): Promise<RunResult> {
    const started = Date.now();
    mkdirSync(spec.runDir, { recursive: true });
    mkdirSync(spec.artifactsDir, { recursive: true });
    // 権限ルールとサンドボックスのパスは実体のパスで書く(macOS の /var → /private/var など)
    const cwd = realpathSync(spec.cwd);
    const artifactsDir = realpathSync(spec.artifactsDir);

    const settingsPath = join(spec.runDir, "settings.json");
    const settings = buildRunSettings({
      worktree: cwd,
      artifactsDir,
      write: spec.write,
      bashWritesWorktree: spec.bashWritesWorktree,
      allowedDomains: spec.allowedDomains,
    });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    writeFileSync(join(spec.runDir, "prompt.md"), spec.prompt);
    const args = buildClaudeArgs({ ...spec, artifactsDir, settingsPath });
    writeFileSync(
      join(spec.runDir, "command.txt"),
      `cd ${shellQuote(cwd)} && ${[this.claudePath, ...args].map(shellQuote).join(" ")} < ${shellQuote(join(spec.runDir, "prompt.md"))}\n`,
    );
    const streamLog = join(spec.runDir, "stream.jsonl");
    const env = buildAgentEnv(this.parentEnv, spec.extraEnv);

    return new Promise((resolve) => {
      const collector = new StreamCollector();
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const timers: NodeJS.Timeout[] = [];
      const finish = (r: Omit<RunResult, "durationMs" | "models" | "permissionDenials"> & Partial<RunResult>) => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        const s = collector.summary();
        resolve({ models: s.models, permissionDenials: s.permissionDenials, durationMs: Date.now() - started, ...r });
      };

      const child = spawn(this.claudePath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      child.on("error", (e) => finish({ status: "failed", error: `claude を起動できません(${this.claudePath}): ${e.message}` }));
      child.stdin.on("error", () => {}); // 先に終了した場合の EPIPE は無視する
      child.stdin.end(spec.prompt);
      child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
      createInterface({ input: child.stdout }).on("line", (line) => {
        appendFileSync(streamLog, line + "\n");
        for (const e of collector.push(line)) onEvent(e);
      });

      timers.push(
        setTimeout(() => {
          timedOut = true;
          child.kill("SIGINT");
          timers.push(setTimeout(() => child.kill("SIGTERM"), this.killGraceMs));
          timers.push(setTimeout(() => child.kill("SIGKILL"), this.killGraceMs * 2));
        }, spec.timeoutSec * 1000),
      );

      child.on("close", (code) => {
        const s = collector.summary();
        const base = { sessionId: s.sessionId, costUsd: s.costUsd, resultText: s.resultText, structuredOutput: s.structuredOutput };
        if (timedOut) return finish({ ...base, status: "timeout", error: `時間の上限(${spec.timeoutSec}秒)を超えました` });
        if (!s.hasResult) {
          return finish({ ...base, status: "failed", error: `claude が結果を返さずに終了しました(終了コード ${code}): ${stderr.trim()}` });
        }
        if (s.isError) return finish({ ...base, status: "failed", error: `claude がエラーで終了しました(${s.subtype}): ${s.resultText ?? ""}` });
        if (s.structuredOutput == null) return finish({ ...base, status: "failed", error: "判定(structured_output)が返されませんでした" });
        finish({ ...base, status: "succeeded" });
      });
    });
  }
}
