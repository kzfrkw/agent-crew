import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addApproval, getRepoProfile, listEvents, listValidApprovals, type Task } from "../db/store.ts";
import { headSha } from "../git/worktree.ts";
import type { Profile } from "../roles/schemas.ts";
import type { AppContext } from "./context.ts";
import { primaryRepo } from "./handlers.ts";
import { invokeRole } from "./invoke.ts";
import { taskDir } from "./paths.ts";

export type VerifyResult =
  | { status: "passed" | "failed"; command: string; cached?: boolean; reportPath: string }
  | { status: "skipped"; reportPath: string }
  | { status: "error"; reason: string };

/** 実装者が用意・変更したテストコマンド(あれば)、無ければプロファイルのもの */
export function testCommandFor(ctx: AppContext, task: Task, repoId: number): string | null {
  const recorded = listEvents(ctx.db, task.id, 1000).filter((e) => e.kind === "test_command").at(-1);
  if (recorded) return (recorded.payload as { command: string }).command;
  return (getRepoProfile(ctx.db, repoId) as Profile | null)?.commands.test ?? null;
}

/**
 * 実装の直後に、テストをオーケストレーターの責任で再実行する(設計メモ4章「テスト結果の確認」)。
 * テストはエージェントが書いたコードなのでサンドボックス内の verifier に実行させ、
 * 合否は verifier の申告ではなく、stream に残る Bash の終了状態で判定する。
 */
export async function verifyTests(ctx: AppContext, task: Task): Promise<VerifyResult> {
  const tr = primaryRepo(ctx, task);
  const dir = taskDir(ctx.home, task.id);
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, "verify-report.md");
  const head = headSha(tr.worktreePath, ctx.gitEnv);
  const write = (body: string) => writeFileSync(reportPath, `# テストの再実行結果\n\n- コミット: ${head}\n${body}\n`);

  const test = testCommandFor(ctx, task, tr.repoId);
  if (!test) {
    write("- テストコマンドが無いため、確認していません(テスト基盤の整備前)");
    return { status: "skipped", reportPath };
  }
  const install = (getRepoProfile(ctx.db, tr.repoId) as Profile | null)?.commands.install;
  const command = install ? `${install} && ${test}` : test;

  const cached = listValidApprovals(ctx.db, task.id).filter((a) => a.kind === "tests" && a.commitSha === head && a.repoId === tr.repoId).at(-1);
  if (cached) return { status: cached.result === "approved" ? "passed" : "failed", command, cached: true, reportPath };

  const r = await invokeRole(ctx, {
    roleName: "verifier",
    taskId: task.id,
    cwd: tr.worktreePath,
    artifactsDir: dir,
    prompt: `次のコマンドを、作業ディレクトリ(${tr.worktreePath})で Bash ツールを使って1回だけ実行してください。\n\n\`\`\`sh\n${command}\n\`\`\`\n`,
  });
  if (!r.ok) return { status: "error", reason: `テストの再実行に失敗しました: ${r.reason}` };
  const ran = r.result.bashResults.filter((b) => b.command.trim() === command.trim()).at(-1);
  if (!ran) return { status: "error", reason: `verifier が指定のコマンド(${command})を実行しませんでした` };

  const passed = !ran.isError;
  write(`- コマンド: \`${command}\`\n- 結果: ${passed ? "成功" : "失敗"}\n\n## 出力(抜粋)\n\n\`\`\`\n${ran.output}\n\`\`\``);
  addApproval(ctx.db, { taskId: task.id, repoId: tr.repoId, kind: "tests", result: passed ? "approved" : "rejected", commitSha: head });
  return { status: passed ? "passed" : "failed", command, reportPath };
}
