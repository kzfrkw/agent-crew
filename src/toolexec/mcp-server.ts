import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import type { Profile } from "../roles/schemas.ts";
import { defaultDenyRead } from "../browser/app.ts";
import { findFlutterRoot, runSandboxedCommand, toolchainWritable, type CommandResult } from "./command.ts";

/**
 * MCP の橋(設計メモ v0.15、フェーズ6)。エージェントに「プロファイルのテスト/解析のコマンドを、この worktree で実行する」道具だけを渡す。
 * Claude のサンドボックスの中では動かないコマンド(Flutter のテスト)を、ツールが sandbox-exec で囲って代わりに実行する。
 * 任意のコマンドは実行できない(実行するのは、ツールが書いた設定ファイルのコマンドだけ)。
 * MCP は標準入出力の JSON-RPC(1行1メッセージ)。依存を増やさないため、使う部分(initialize / tools/list / tools/call / ping)だけを実装する。
 */

export const TOOL_NAME = "run_project_command";
export const KINDS = ["test", "analyze"] as const;
export type Kind = (typeof KINDS)[number];

/** ツールが実行ごとに書く設定(runDir/tool-exec.json) */
export type ToolExecConfig = {
  cwd: string;
  platform: NonNullable<Profile["platform"]>;
  commands: Record<Kind, string | null>;
  tmpDir: string;
  /** データディレクトリ(資格情報と DB を読めなくするため) */
  dataHome: string;
  /** 実行の記録(1行1件の JSON)。オーケストレーターが実行の後でイベントにする */
  logPath: string;
  timeoutMs?: number;
};

type Exec = (req: { cwd: string; command: string; signal?: AbortSignal }) => Promise<CommandResult>;
type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };

const OUTPUT_FOR_AGENT = 12_000;

export function createMcpHandler(cfg: ToolExecConfig, exec: Exec, signal?: AbortSignal): (m: Message) => Promise<object | null> {
  const available = KINDS.filter((k) => cfg.commands[k]);
  const ok = (id: Message["id"], result: object) => ({ jsonrpc: "2.0", id, result });
  const err = (id: Message["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const text = (id: Message["id"], body: string, isError: boolean) => ok(id, { content: [{ type: "text", text: body }], isError });

  return async (m) => {
    if (m.id === undefined) return null; // 通知には応えない
    switch (m.method) {
      case "initialize":
        return ok(m.id, {
          protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "agent-crew", version: "0.1.0" },
          instructions: "プロファイルのテスト・静的解析のコマンドを、ツールがサンドボックスの中で代わりに実行します。Bash では実行しないでください。",
        });
      case "ping":
        return ok(m.id, {});
      case "tools/list":
        return ok(m.id, {
          tools: [
            {
              name: TOOL_NAME,
              description: `この worktree で、プロファイルのコマンドをツールが代わりに実行し、終了コードと出力の末尾を返します。${available.map((k) => `${k}: \`${cfg.commands[k]}\``).join("、")}`,
              inputSchema: { type: "object", properties: { kind: { type: "string", enum: available, description: "実行するコマンドの種類" } }, required: ["kind"], additionalProperties: false },
            },
          ],
        });
      case "tools/call": {
        if (m.params?.name !== TOOL_NAME) return err(m.id, -32602, `知らない道具です: ${String(m.params?.name)}`);
        const kind = (m.params.arguments as { kind?: unknown } | undefined)?.kind;
        const command = typeof kind === "string" && (KINDS as readonly string[]).includes(kind) ? cfg.commands[kind as Kind] : null;
        if (!command) return text(m.id, `実行できる種類は ${available.join(" / ") || "(なし)"} です`, true);
        const r = await exec({ cwd: cfg.cwd, command, signal });
        appendFileSync(cfg.logPath, JSON.stringify({ kind, command, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs }) + "\n");
        const head = `コマンド: ${command}\n終了コード: ${r.exitCode}${r.timedOut ? "(時間切れで止めました)" : ""}\n所要: ${Math.round(r.durationMs / 1000)}秒\n\n`;
        return text(m.id, head + r.output.slice(-OUTPUT_FOR_AGENT), r.exitCode !== 0 || r.timedOut);
      }
      default:
        return err(m.id, -32601, `未対応のメソッドです: ${String(m.method)}`);
    }
  };
}

/** agent-crew mcp-exec <設定ファイル>: 標準入出力で MCP サーバーとして動く。標準入力が閉じたら、実行中のコマンドを止めて終わる */
export async function serveMcp(configPath: string): Promise<void> {
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as ToolExecConfig;
  const aborter = new AbortController();
  const writable = [cfg.cwd, ...toolchainWritable(cfg.platform, { home: homedir(), flutterRoot: findFlutterRoot() })];
  const handle = createMcpHandler(
    cfg,
    (req) => runSandboxedCommand({ cwd: req.cwd, command: req.command, writable, tmpDir: cfg.tmpDir, denyRead: defaultDenyRead(homedir(), cfg.dataHome), timeoutMs: cfg.timeoutMs, signal: req.signal }),
    aborter.signal,
  );
  const rl = createInterface({ input: process.stdin });
  // 1つずつ順に処理する(同じ worktree でコマンドを同時に動かさない)
  let queue = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let m: Message;
      try {
        m = JSON.parse(line) as Message;
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON として読めません" } }) + "\n");
        return;
      }
      const res = await handle(m);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    });
  });
  await new Promise<void>((resolve) => rl.on("close", resolve));
  aborter.abort();
  await queue;
}
