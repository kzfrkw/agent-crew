import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { addArtifact, addEvent, finishRun, startRun } from "../db/store.ts";
import { parseVerdict, verdictSchemaFor } from "../roles/roles.ts";
import type { RunResult } from "../runner/types.ts";
import type { AppContext } from "./context.ts";
import { runDir } from "./paths.ts";
import { cleanupStrayProcesses } from "../runner/cleanup.ts";
import { isQuotaFailure, quotaBlock, QuotaError, recordUsage } from "./usage.ts";
import { protectedPathsFor } from "./projects.ts";
import { TOOL_NAME, type ToolExecConfig } from "../toolexec/mcp-server.ts";
import { findFlutterRoot, toolchainWritable } from "../toolexec/command.ts";
import { homedir } from "node:os";

/** Flutter の依存の準備(flutter pub get)に要る通信先 */
const FLUTTER_DOMAINS = ["pub.dev", "storage.googleapis.com"];

/** MCP の橋で代わりに実行するコマンド(Flutter のリポジトリ。設計メモ v0.15) */
export type ToolCommands = Pick<ToolExecConfig, "platform" | "commands">;

const AGENT_CREW_BIN = new URL("../../bin/agent-crew.js", import.meta.url).pathname;
const MCP_TOOL = `mcp__agent-crew__${TOOL_NAME}`;

export type InvokeResult =
  | { ok: true; runId: number; verdict: string; summary: string; extra: Record<string, unknown>; result: RunResult }
  | { ok: false; runId: number; failure: "limit" | "error" | "cancelled"; reason: string; result?: RunResult };

/** 成果物の先頭の frontmatter から verdict を読む */
export function readArtifactVerdict(path: string): string | undefined {
  const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path, "utf8"));
  if (!m) return undefined;
  const fm = parseYaml(m[1]!) as { verdict?: unknown } | null;
  return typeof fm?.verdict === "string" ? fm.verdict : undefined;
}

/**
 * 役割を1回起動する(全役割で共通)。実行の記録、イベントの保存、判定の検証、成果物の確認と登録を行う。
 * 状態遷移はここでは行わない(呼び出し側が判定を出来事として渡す)。
 */
export async function invokeRole(
  ctx: AppContext,
  o: { roleName: string; taskId?: number; projectId?: number; cwd: string; artifactsDir: string; prompt: string; extraEnv?: Record<string, string>; toolCommands?: ToolCommands },
): Promise<InvokeResult> {
  const role = ctx.roles.get(o.roleName);
  if (!role) throw new Error(`役割 ${o.roleName} が定義されていません`);
  // 利用枠の上限の間は起動しない(1つの段で何度も起動する役割もあるため、ここでも確かめる。設計メモ v0.17)
  const blocked = quotaBlock(ctx);
  if (blocked) throw new QuotaError(blocked);
  const run = startRun(ctx.db, { taskId: o.taskId, projectId: o.projectId, role: role.name, model: role.model });
  mkdirSync(runDir(ctx.home, run.id), { recursive: true });
  // 前回の成果物は消さずに残す(読み返して追記できるように)。今回の実行で更新されたかは更新時刻の変化で判定する
  const outputPath = role.output ? join(o.artifactsDir, role.output) : undefined;
  const mtimeBefore = outputPath && existsSync(outputPath) ? statSync(outputPath).mtimeMs : undefined;
  const fail = (failure: "limit" | "error" | "cancelled", reason: string, result?: RunResult, state: "failed" | "timeout" | "cancelled" = "failed"): InvokeResult => {
    finishRun(ctx.db, run.id, { state, error: reason, sessionId: result?.sessionId, costUsd: result?.costUsd, structuredOutput: result?.structuredOutput });
    addEvent(ctx.db, { taskId: o.taskId, runId: run.id, kind: "run_failed", payload: { role: role.name, failure, reason } });
    return { ok: false, runId: run.id, failure, reason, result };
  };

  const bridge = o.toolCommands ? writeBridge(ctx, run.id, o.cwd, o.toolCommands, o.taskId) : undefined;
  const prompt = bridge ? `${o.prompt}\n## テストと静的解析の実行\n- テスト・静的解析は Bash では実行せず、MCP の道具 \`${TOOL_NAME}\`(kind: ${bridge.kinds.join(" / ")})を使ってください。ツールがサンドボックスの中で代わりに実行し、終了コードと出力を返します(Bash の中ではこれらのコマンドは止まります)\n` : o.prompt;

  const webTools = role.tools.filter((t) => t === "WebSearch" || t === "WebFetch");
  let result: RunResult;
  let sawRejected = false;
  const startedAt = Date.now();
  try {
    result = await ctx.runner.run(
      {
        role: role.name,
        cwd: o.cwd,
        runDir: runDir(ctx.home, run.id),
        artifactsDir: o.artifactsDir,
        prompt,
        systemPromptAppend: role.prompt,
        model: role.model,
        effort: role.effort,
        tools: role.tools,
        write: role.permissions.write,
        bashWritesWorktree: role.permissions.bashWritesWorktree,
        localServer: role.permissions.localServer,
        jsonSchema: verdictSchemaFor(role),
        timeoutSec: Math.min(role.timeoutSec, ctx.config.limits.runTimeoutSec),
        maxBudgetUsd: Math.min(role.maxBudgetUsd, ctx.config.limits.runMaxBudgetUsd),
        allowedDomains: o.toolCommands?.platform === "flutter" ? [...new Set([...ctx.config.sandbox.allowedDomains, ...FLUTTER_DOMAINS])] : ctx.config.sandbox.allowedDomains,
        extraEnv: o.extraEnv,
        denyRead: protectedPathsFor(ctx, { taskId: o.taskId, projectId: o.projectId, cwd: o.cwd }),
        ...(bridge ? { mcpServers: bridge.servers } : {}),
        // MCP の橋の道具と、役割が使う Web の道具(調査担当だけ。フェーズ9)を許可する
        ...(bridge || webTools.length ? { extraAllowedTools: [...(bridge ? [MCP_TOOL] : []), ...webTools] } : {}),
        // 依存の準備(flutter pub get)は Bash で行うため、道具のキャッシュに書けるようにする(設計メモ v0.15)
        ...(o.toolCommands ? { extraWritable: toolchainWritable(o.toolCommands.platform, { home: homedir(), flutterRoot: findFlutterRoot() }) } : {}),
        signal: o.taskId === undefined ? undefined : ctx.stops?.get(o.taskId)?.signal,
      },
      (e) => {
        addEvent(ctx.db, { taskId: o.taskId, runId: run.id, kind: e.kind, payload: e.payload });
        if (e.kind === "rate_limit") {
          recordUsage(ctx.db, e.payload);
          if ((e.payload as { status?: unknown } | undefined)?.status === "rejected") sawRejected = true;
        }
      },
    );
  } catch (e) {
    await cleanup(ctx, o, role.name, run.id, startedAt);
    if (bridge) recordBridge(ctx, o.taskId, run.id, role.name, bridge.logPath);
    return fail("error", `実行に失敗しました: ${(e as Error).message}`);
  }
  await cleanup(ctx, o, role.name, run.id, startedAt);
  if (bridge) recordBridge(ctx, o.taskId, run.id, role.name, bridge.logPath);

  if (result.status === "cancelled") return fail("cancelled", result.error ?? "人が停止しました", result, "cancelled");
  // 利用枠の上限で止まった役割は失敗にしない。実行は中止として記録し、タスクは同じ状態のまま待つ(設計メモ v0.17)
  if (result.status !== "succeeded" && isQuotaFailure(result.error, sawRejected)) {
    finishRun(ctx.db, run.id, { state: "cancelled", error: `利用枠: ${result.error ?? "上限"}`, sessionId: result.sessionId, costUsd: result.costUsd });
    throw new QuotaError(quotaBlock(ctx) ?? { until: Date.now() + 15 * 60_000, window: "unknown", reason: "利用枠の上限に達しました" });
  }
  if (result.status === "timeout") return fail("limit", result.error ?? "時間の上限を超えました", result, "timeout");
  if (result.status !== "succeeded") {
    const reason = result.error ?? "実行に失敗しました";
    return fail(/max_budget/.test(reason) ? "limit" : "error", reason, result);
  }

  let parsed: ReturnType<typeof parseVerdict>;
  try {
    parsed = parseVerdict(role, result.structuredOutput);
  } catch (e) {
    return fail("error", (e as Error).message, result);
  }

  if (role.output) {
    const path = outputPath!;
    if (!existsSync(path) || statSync(path).mtimeMs === mtimeBefore) {
      return fail("error", `成果物 ${role.output} が今回の実行で書かれていません`, result);
    }
    const fileVerdict = readArtifactVerdict(path);
    if (fileVerdict !== parsed.verdict) {
      return fail("error", `成果物 ${role.output} の判定(${fileVerdict ?? "なし"})と最終応答の判定(${parsed.verdict})が一致しません`, result);
    }
    copyFileSync(path, join(runDir(ctx.home, run.id), role.output));
    addArtifact(ctx.db, { taskId: o.taskId, runId: run.id, kind: basename(role.output, ".md"), path, verdict: parsed.verdict });
  }

  finishRun(ctx.db, run.id, {
    state: "succeeded",
    verdict: parsed.verdict,
    summary: parsed.summary,
    sessionId: result.sessionId,
    costUsd: result.costUsd,
    structuredOutput: result.structuredOutput,
  });
  return { ok: true, runId: run.id, verdict: parsed.verdict, summary: parsed.summary, extra: parsed.extra, result };
}

/** MCP の橋の設定を実行ディレクトリに書く。サーバーは claude が起動する(agent-crew mcp-exec <設定>) */
function writeBridge(ctx: AppContext, runId: number, cwd: string, tc: ToolCommands, taskId: number | undefined) {
  const dir = runDir(ctx.home, runId);
  const cfg: ToolExecConfig = {
    cwd,
    platform: tc.platform,
    commands: tc.commands,
    tmpDir: join(dir, "tmp"),
    dataHome: ctx.home,
    logPath: join(dir, "tool-commands.jsonl"),
    taskId,
    slots: ctx.config.concurrency,
    deviceType: ctx.config.simulatorDevice,
    denyRead: protectedPathsFor(ctx, { taskId, cwd }),
  };
  const cfgPath = join(dir, "tool-exec.json");
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return {
    servers: { "agent-crew": { command: process.execPath, args: [AGENT_CREW_BIN, "mcp-exec", cfgPath] } },
    logPath: cfg.logPath,
    kinds: (Object.keys(tc.commands) as (keyof ToolCommands["commands"])[]).filter((k) => tc.commands[k]),
  };
}

/** 橋で実行したコマンドを、イベントにする(GUI の実行ログに出す) */
function recordBridge(ctx: AppContext, taskId: number | undefined, runId: number, role: string, logPath: string): void {
  if (!existsSync(logPath)) return;
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      addEvent(ctx.db, { taskId, runId, kind: "tool_command", payload: { purpose: "agent", role, ...(JSON.parse(line) as object) } });
    } catch {
      // 壊れた行は飛ばす
    }
  }
}

/**
 * 役割が作業ディレクトリに残したプロセス(QA が起動したサーバーなど)を止める。サンドボックスの中からは、
 * 別の Bash の実行で起動したプロセスを止められないため(自己適用で発見)。止めたものはイベントに残す
 */
async function cleanup(ctx: AppContext, o: { taskId?: number; cwd: string }, role: string, runId: number, startedAt: number): Promise<void> {
  const killed = await cleanupStrayProcesses(o.cwd, startedAt);
  if (killed.length > 0) addEvent(ctx.db, { taskId: o.taskId, runId, kind: "cleanup", payload: { role, processes: killed } });
}
