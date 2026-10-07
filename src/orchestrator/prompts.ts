/** 役割に渡す入力(標準入力のプロンプト)。役割の責務は roles/*.md、ここは「今回の材料」だけを書く */

export function profilerPrompt(o: { projectName: string; repoPath: string; worktree: string; artifactsDir: string }): string {
  return `# プロジェクト登録の調査

- プロジェクト名: ${o.projectName}
- 対象リポジトリ(元の場所。ここには書き込まないこと): ${o.repoPath}
- 調査用の作業ディレクトリ(既定ブランチの最新を展開したworktree。依存の準備やテストの実行はここで行う): ${o.worktree}
- 成果物ディレクトリ: ${o.artifactsDir}

成果物ディレクトリに \`profile.md\` を書き、構造化出力で判定とプロファイルを返してください。
`;
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getProject, getRepoProfile, listRepos, listTaskRepos, type Task } from "../db/store.ts";
import type { Profile } from "../roles/schemas.ts";
import type { AppContext } from "./context.ts";
import { projectDir, taskDir } from "./paths.ts";
import type { Role } from "./transitions.ts";

/** タスクの役割に共通の入力(チケット、作業場所、参照するファイル)と、役割ごとの今回やること */
export function taskPrompt(ctx: AppContext, task: Task, role: Role, extra: string[] = []): string {
  const project = getProject(ctx.db, task.projectId)!;
  const pdir = projectDir(ctx.home, project.id);
  const tdir = taskDir(ctx.home, task.id);
  const repos = listRepos(ctx.db, project.id);
  const trs = listTaskRepos(ctx.db, task.id);
  const profile = repos[0] ? (getRepoProfile(ctx.db, repos[0].id) as Profile | null) : null;
  const ref = (label: string, path: string) => (existsSync(path) ? [`- ${label}: ${path}`] : []);

  return [
    `# タスク #${task.id}: ${task.title}`,
    "",
    `- 種別: ${task.kind === "test_infra" ? "テスト基盤整備" : "通常"}`,
    `- 差し戻しの回数: ${task.reviewRounds}`,
    "",
    "## チケット本文",
    "",
    task.body.trim() || "(本文なし)",
    "",
    "## 作業場所",
    ...trs.map((tr) => {
      const repo = repos.find((r) => r.id === tr.repoId);
      return `- [${repo?.role}] worktree: ${tr.worktreePath}(ブランチ ${tr.branchName}、ベース ${tr.baseSha.slice(0, 12)})`;
    }),
    `- 成果物ディレクトリ: ${tdir}`,
    "",
    "## 参照するファイル",
    ...ref("プロジェクトプロファイル", join(pdir, "profile.md")),
    ...ref("設計判断ログ", join(pdir, "decisions.md")),
    ...ref("計画", join(tdir, "plan.md")),
    ...ref("実装メモ", join(tdir, "impl-notes.md")),
    ...ref("テストの再実行結果", join(tdir, "verify-report.md")),
    ...ref("レビュー結果", join(tdir, "review.md")),
    ...ref("QA結果", join(tdir, "qa-report.md")),
    ...ref("人からのコメント・回答(最優先で従う)", join(tdir, "human-notes.md")),
    "",
    ...(profile
      ? [
          "## プロファイルのコマンド(リポジトリのルートで実行)",
          `- 依存の準備: ${profile.commands.install ?? "なし"}`,
          `- ビルド: ${profile.commands.build ?? "なし"}`,
          `- テスト: ${profile.commands.test ?? "なし"}`,
          `- 起動: ${profile.commands.start ?? "なし"}(確認URL: ${profile.startUrl ?? "なし"})`,
          "",
        ]
      : []),
    "## 今回やること",
    ...ROLE_INSTRUCTIONS[role],
    ...extra,
    "",
  ].join("\n");
}

const ROLE_INSTRUCTIONS: Record<Role, string[]> = {
  planner: ["- 成果物ディレクトリに `plan.md` を書き、判定を返してください。人のコメントがあれば、それを反映して計画を直してください"],
  implementer: [
    "- `plan.md` に沿って、テスト先行で実装し、worktree にコミットしてください。成果物ディレクトリに `impl-notes.md` を書いてください",
    "- 差し戻しの場合は、レビュー結果・QA結果・テストの再実行結果・人のコメントの指摘をすべて解消してください",
  ],
  reviewer: ["- ベースからの差分をレビューし、成果物ディレクトリに `review.md` を書いてください"],
  qa: ["- 受け入れ条件を動くアプリで確認し、成果物ディレクトリに `qa-report.md` を書いてください"],
  integrator: ["- 成果物ディレクトリに `pr-draft.md` を書いてください。git の操作は行わないでください"],
};
