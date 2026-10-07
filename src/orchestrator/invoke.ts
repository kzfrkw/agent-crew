import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { addArtifact, addEvent, finishRun, startRun } from "../db/store.ts";
import { parseVerdict, verdictSchemaFor } from "../roles/roles.ts";
import type { RunResult } from "../runner/types.ts";
import type { AppContext } from "./context.ts";
import { runDir } from "./paths.ts";

export type InvokeResult =
  | { ok: true; runId: number; verdict: string; summary: string; extra: Record<string, unknown>; result: RunResult }
  | { ok: false; runId: number; failure: "limit" | "error"; reason: string; result?: RunResult };

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
  o: { roleName: string; taskId?: number; projectId?: number; cwd: string; artifactsDir: string; prompt: string; extraEnv?: Record<string, string> },
): Promise<InvokeResult> {
  const role = ctx.roles.get(o.roleName);
  if (!role) throw new Error(`役割 ${o.roleName} が定義されていません`);
  const run = startRun(ctx.db, { taskId: o.taskId, projectId: o.projectId, role: role.name, model: role.model });
  mkdirSync(runDir(ctx.home, run.id), { recursive: true });
  // 前回の成果物は消さずに残す(読み返して追記できるように)。今回の実行で更新されたかは更新時刻の変化で判定する
  const outputPath = role.output ? join(o.artifactsDir, role.output) : undefined;
  const mtimeBefore = outputPath && existsSync(outputPath) ? statSync(outputPath).mtimeMs : undefined;
  const fail = (failure: "limit" | "error", reason: string, result?: RunResult, state: "failed" | "timeout" = "failed"): InvokeResult => {
    finishRun(ctx.db, run.id, { state, error: reason, sessionId: result?.sessionId, costUsd: result?.costUsd, structuredOutput: result?.structuredOutput });
    addEvent(ctx.db, { taskId: o.taskId, runId: run.id, kind: "run_failed", payload: { role: role.name, failure, reason } });
    return { ok: false, runId: run.id, failure, reason, result };
  };

  let result: RunResult;
  try {
    result = await ctx.runner.run(
      {
        role: role.name,
        cwd: o.cwd,
        runDir: runDir(ctx.home, run.id),
        artifactsDir: o.artifactsDir,
        prompt: o.prompt,
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
        allowedDomains: ctx.config.sandbox.allowedDomains,
        extraEnv: o.extraEnv,
      },
      (e) => addEvent(ctx.db, { taskId: o.taskId, runId: run.id, kind: e.kind, payload: e.payload }),
    );
  } catch (e) {
    return fail("error", `実行に失敗しました: ${(e as Error).message}`);
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
