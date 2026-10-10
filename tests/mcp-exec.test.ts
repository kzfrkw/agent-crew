import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpHandler, type ToolExecConfig } from "../src/toolexec/mcp-server.ts";
import { inAgentSandbox } from "./helpers/env.ts";
import { tempDir } from "./helpers/gitrepo.ts";

const mac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && !inAgentSandbox;
const bin = new URL("../bin/agent-crew.js", import.meta.url).pathname;

function config(over: Partial<ToolExecConfig> = {}): ToolExecConfig {
  const root = tempDir("agent-crew-mcp-");
  return { cwd: root, platform: "flutter", commands: { test: "flutter test", analyze: null }, tmpDir: join(root, "tmp"), dataHome: root, logPath: join(root, "tool-commands.jsonl"), ...over };
}

describe("MCP の橋: プロファイルのコマンドだけをツールが代わりに実行する(フェーズ6)", () => {
  it("初期化に応え、道具の一覧には設定されたコマンドの種類だけを出す", async () => {
    const h = createMcpHandler(config(), async () => ({ exitCode: 0, timedOut: false, output: "", durationMs: 1 }));
    const init = await h({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } });
    expect(init).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "agent-crew" } } });
    expect(await h({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list = (await h({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result: { tools: { name: string; inputSchema: { properties: { kind: { enum: string[] } } } }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["run_project_command"]);
    expect(list.result.tools[0]!.inputSchema.properties.kind.enum).toEqual(["test"]);
  });

  it("実行すると終了コードと出力の末尾を返し、記録に残す。失敗は isError", async () => {
    const cfg = config();
    const calls: { command: string; cwd: string }[] = [];
    const h = createMcpHandler(cfg, async (req) => {
      calls.push({ command: req.command, cwd: req.cwd });
      return { exitCode: 1, timedOut: false, output: "Some tests failed.", durationMs: 1200 };
    });
    const r = (await h({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_project_command", arguments: { kind: "test" } } })) as { result: { isError: boolean; content: { type: string; text: string }[] } };
    expect(calls).toEqual([{ command: "flutter test", cwd: cfg.cwd }]);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]!.text).toContain("終了コード: 1");
    expect(r.result.content[0]!.text).toContain("Some tests failed.");
    expect(JSON.parse(readFileSync(cfg.logPath, "utf8").trim())).toMatchObject({ kind: "test", command: "flutter test", exitCode: 1 });
  });

  it("設定に無い種類・知らない道具・知らないメソッドはエラー(任意のコマンドは実行できない)", async () => {
    const h = createMcpHandler(config(), async () => ({ exitCode: 0, timedOut: false, output: "", durationMs: 1 }));
    const bad = (await h({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "run_project_command", arguments: { kind: "analyze" } } })) as { result: { isError: boolean } };
    expect(bad.result.isError).toBe(true);
    const cmd = (await h({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "run_project_command", arguments: { kind: "test", command: "rm -rf /" } } })) as { result: { isError: boolean } };
    expect(cmd.result.isError).toBe(false); // 余計な引数は無視して、設定のコマンドを実行する
    expect(await h({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "bash", arguments: {} } })).toMatchObject({ id: 6, error: { code: -32602 } });
    expect(await h({ jsonrpc: "2.0", id: 7, method: "resources/list" })).toMatchObject({ id: 7, error: { code: -32601 } });
  });
});

describe.skipIf(!mac)("MCP の橋(実際のプロセス、標準入出力)", () => {
  it("agent-crew mcp-exec が標準入出力で応え、sandbox-exec の中でコマンドを実行する", async () => {
    const cfg = config({ platform: "web", commands: { test: "echo from-sandbox; exit 0", analyze: null } });
    const path = join(cfg.dataHome, "tool-exec.json");
    writeFileSync(path, JSON.stringify(cfg));
    const child = spawn(process.execPath, [bin, "mcp-exec", path], { stdio: ["pipe", "pipe", "inherit"] });
    const lines: string[] = [];
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const parts = buf.split("\n");
      buf = parts.pop()!;
      lines.push(...parts.filter(Boolean));
    });
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
    const waitFor = async (id: number) => {
      for (let i = 0; i < 200; i++) {
        const hit = lines.map((l) => JSON.parse(l)).find((m) => m.id === id);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`id ${id} の応答がありません`);
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect((await waitFor(1)).result.serverInfo.name).toBe("agent-crew");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_project_command", arguments: { kind: "test" } } });
    const r = await waitFor(2);
    expect(r.result.isError).toBe(false);
    expect(r.result.content[0].text).toContain("from-sandbox");
    child.stdin.end();
    await new Promise((r) => child.on("close", r));
  }, 30_000);
});
