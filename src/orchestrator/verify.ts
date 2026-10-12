import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addApproval, addEvent, getRepoProfile, listEvents, listValidApprovals, type Task } from "../db/store.ts";
import { headSha } from "../git/worktree.ts";
import type { Profile } from "../roles/schemas.ts";
import type { AppContext } from "./context.ts";
import { orderedTaskRepos } from "./handlers.ts";
import { invokeRole } from "./invoke.ts";
import { platformOf, protectedPathsFor } from "./projects.ts";
import { defaultToolExec } from "../toolexec/command.ts";
import { SimulatorSession } from "../mobile/session.ts";
import { taskDir } from "./paths.ts";

export type VerifyResult =
  | { status: "passed" | "failed"; command: string; cached?: boolean; reportPath: string }
  | { status: "skipped"; reportPath: string }
  | { status: "error"; reason: string };

/** 実装者が用意・変更したテストコマンド(あれば。リポジトリごと)、無ければプロファイルのもの */
export function testCommandFor(ctx: AppContext, task: Task, repoId: number): string | null {
  const recorded = listEvents(ctx.db, task.id, 1000)
    .filter((e) => e.kind === "test_command")
    .filter((e) => {
      const r = (e.payload as { repoId?: number }).repoId;
      return r === undefined || r === repoId;
    })
    .at(-1);
  if (recorded) return (recorded.payload as { command: string }).command;
  return (getRepoProfile(ctx.db, repoId) as Profile | null)?.commands.test ?? null;
}

type RepoResult = { role: string; status: "passed" | "failed" | "skipped" | "error"; command?: string; head: string; detail: string; cached?: boolean };

/**
 * 実装の直後に、テストをオーケストレーターの責任で再実行する(設計メモ4章「テスト結果の確認」)。
 * テストはエージェントが書いたコードなのでサンドボックス内の verifier に実行させ、
 * 合否は verifier の申告ではなく、stream に残る Bash の終了状態で判定する。複数リポジトリでは、リポジトリごとに実行する(v0.14)
 */
export async function verifyTests(ctx: AppContext, task: Task): Promise<VerifyResult> {
  const trs = orderedTaskRepos(ctx, task);
  const dir = taskDir(ctx.home, task.id);
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, "verify-report.md");
  const results: RepoResult[] = [];
  for (const tr of trs) {
    const r = await verifyRepo(ctx, task, tr, dir);
    results.push(r);
    if (r.status === "error") return { status: "error", reason: trs.length > 1 ? `[${tr.role}] ${r.detail}` : r.detail };
  }
  const multi = trs.length > 1;
  writeFileSync(
    reportPath,
    `# テストの再実行結果\n\n${results
      .map((r) => `${multi ? `## [${r.role}]\n\n` : ""}- コミット: ${r.head}\n${r.command ? `- コマンド: \`${r.command}\`\n` : ""}- 結果: ${{ passed: "成功", failed: "失敗", skipped: "未確認(テストコマンドが無い。テスト基盤の整備前)", error: "エラー" }[r.status]}${r.cached ? "(同じコミットで成功済み)" : ""}\n${r.detail ? `\n## 出力(抜粋)\n\n\`\`\`\n${r.detail}\n\`\`\`\n` : ""}`)
      .join("\n")}`,
  );
  const ran = results.filter((r) => r.status !== "skipped");
  if (ran.length === 0) return { status: "skipped", reportPath };
  const command = ran.map((r) => (multi ? `[${r.role}] ${r.command}` : r.command)).join(" / ");
  if (results.some((r) => r.status === "failed")) return { status: "failed", command, reportPath };
  return { status: "passed", command, cached: ran.every((r) => r.cached) || undefined, reportPath };
}

async function verifyRepo(ctx: AppContext, task: Task, tr: { repoId: number; worktreePath: string; role: string }, dir: string): Promise<RepoResult> {
  const head = headSha(tr.worktreePath, ctx.gitEnv);
  const test = testCommandFor(ctx, task, tr.repoId);
  if (!test) return { role: tr.role, status: "skipped", head, detail: "" };
  // 依存の準備(プロファイルの install)はしない。準備は worktree に書ける実装者の責任で、
  // node_modules がある状態での入れ直しはサンドボックスに拒否されることがある(フェーズ4b で判明)
  const command = test;

  // 同じコミットで成功していれば再実行しない。失敗は記録だけで使わない(環境を直して再実行できるように。フェーズ4b で判明)
  const cached = listValidApprovals(ctx.db, task.id).filter((a) => a.kind === "tests" && a.commitSha === head && a.repoId === tr.repoId && a.result === "approved").at(-1);
  if (cached) return { role: tr.role, status: "passed", command, head, detail: "", cached: true };

  // Flutter は Claude のサンドボックスの中でテストが動かないため、ツールが sandbox-exec で直接実行する(設計メモ v0.15)
  const platform = platformOf(getRepoProfile(ctx.db, tr.repoId) as Profile | null);
  if (platform !== "web") {
    const exec = ctx.toolExec ?? defaultToolExec;
    // ネイティブ iOS のテストはシミュレータで動く。{simulator} があれば、この実行の間だけ借りる(設計メモ v0.16)
    const session = new SimulatorSession({ home: ctx.home, taskId: task.id, simctl: ctx.simctl, slots: ctx.config.concurrency, deviceType: ctx.config.simulatorDevice });
    let res;
    try {
      res = await exec(ctx, {
        cwd: tr.worktreePath,
        command: await session.resolve(command),
        platform,
        tmpDir: join(dir, "tmp", `verify-${tr.repoId}`),
        signal: ctx.stops?.get(task.id)?.signal,
        denyRead: protectedPathsFor(ctx, { taskId: task.id }),
      });
    } catch (e) {
      return { role: tr.role, status: "error", head, detail: `テストの再実行に失敗しました: ${(e as Error).message}` };
    } finally {
      await session.close();
    }
    addEvent(ctx.db, { taskId: task.id, kind: "tool_command", payload: { purpose: "verify", repoId: tr.repoId, command, exitCode: res.exitCode, timedOut: res.timedOut, durationMs: res.durationMs } });
    const passed = res.exitCode === 0 && !res.timedOut;
    addApproval(ctx.db, { taskId: task.id, repoId: tr.repoId, kind: "tests", result: passed ? "approved" : "rejected", commitSha: head });
    const detail = (res.timedOut ? "(時間切れで止めました)\n" : "") + res.output.slice(-4000);
    return { role: tr.role, status: passed ? "passed" : "failed", command, head, detail };
  }

  const r = await invokeRole(ctx, {
    roleName: "verifier",
    taskId: task.id,
    cwd: tr.worktreePath,
    artifactsDir: dir,
    prompt: `次のコマンドを、作業ディレクトリ(${tr.worktreePath})で Bash ツールを使って1回だけ実行してください。\n\n\`\`\`sh\n${command}\n\`\`\`\n`,
  });
  if (!r.ok) return { role: tr.role, status: "error", head, detail: `テストの再実行に失敗しました: ${r.reason}` };
  const ran = r.result.bashResults.filter((b) => b.command.trim() === command.trim()).at(-1);
  if (!ran) return { role: tr.role, status: "error", head, detail: `verifier が指定のコマンド(${command})を実行しませんでした` };

  const passed = !ran.isError;
  addApproval(ctx.db, { taskId: task.id, repoId: tr.repoId, kind: "tests", result: passed ? "approved" : "rejected", commitSha: head });
  return { role: tr.role, status: passed ? "passed" : "failed", command, head, detail: ran.output };
}
