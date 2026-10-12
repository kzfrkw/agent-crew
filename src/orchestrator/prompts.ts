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

import { lastBounce } from "./bounce.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getProject, getRepoProfile, listRepos, listTaskRepos, type Task } from "../db/store.ts";
import type { Profile } from "../roles/schemas.ts";
import type { AppContext } from "./context.ts";
import { projectDir, taskDir } from "./paths.ts";
import type { Role } from "./transitions.ts";

/** 状態に結びつく役割と、レビュワーの内部で動く監査担当 */
export type PromptRole = Role | "auditor" | "retrospective";

/** タスクの役割に共通の入力(チケット、作業場所、参照するファイル)と、役割ごとの今回やること */
export function taskPrompt(ctx: AppContext, task: Task, role: PromptRole, extra: string[] = []): string {
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
    ...(repos.length > 1
      ? [
          "## リポジトリ(このプロジェクトは複数のリポジトリのまとまり)",
          ...repos.map((r) => {
            const tr = trs.find((x) => x.repoId === r.id);
            const planned = task.repos?.includes(r.role);
            return `- [${r.role}] 本体: ${r.path}(既定ブランチ ${r.defaultBranch})${tr ? `、このタスクの worktree: ${tr.worktreePath}` : ""}${task.repos ? (planned ? "(変更する)" : "(変更しない)") : ""}`;
          }),
          ...(task.repos ? [`- 実装する順: ${task.repos.join(" → ")}`] : []),
          ...repos.flatMap((r, i) => (i === 0 ? [] : ref(`[${r.role}] のプロファイル`, join(pdir, "repos", r.role, "profile.md")))),
          "",
        ]
      : []),
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
    ...ref("デザイン方針(UI の基準)", join(pdir, "design-guide.md")),
    ...ref("計画", join(tdir, "plan.md")),
    ...ref("設計(設計者)", join(tdir, "design.md")),
    ...ref("UI 仕様(デザイナー)", join(tdir, "ui-spec.md")),
    ...ref("実装メモ", join(tdir, "impl-notes.md")),
    ...ref("テストの再実行結果", join(tdir, "verify-report.md")),
    ...ref("レビュー結果", join(tdir, "review.md")),
    ...ref("Must 指摘の監査結果(invalid とされた指摘は対応不要)", join(tdir, "audit.md")),
    ...ref("QA結果", join(tdir, "qa-report.md")),
    ...ref("デザインレビューの結果", join(tdir, "design-review.md")),
    ...ref("人の変更(人が引き取って直した内容)", join(tdir, "human-changes.md")),
    ...ref("人からのコメント・回答(最優先で従う)", join(tdir, "human-notes.md")),
    "",
    ...(profile
      ? [
          "## プロファイルのコマンド(リポジトリのルートで実行)",
          ...(profile.platform === "flutter" ? ["- 種類: Flutter(iOS)"] : profile.platform === "ios" ? ["- 種類: ネイティブ iOS(Xcode。{simulator} はツールが貸し出したシミュレータに置き換える)"] : []),
          `- 依存の準備: ${profile.commands.install ?? "なし"}(実装者は worktree で最初に1回、依存を変えたら再度実行する。テストの再実行では実行しない)`,
          `- ビルド: ${profile.commands.build ?? "なし"}`,
          `- テスト: ${profile.commands.test ?? "なし"}`,
          ...(profile.commands.analyze ? [`- 静的解析: ${profile.commands.analyze}`] : []),
          ...(profile.commands.screens ? [`- 画面を撮る UI テスト: ${profile.commands.screens}`] : []),
          `- 起動: ${profile.commands.start ?? "なし"}(確認URL: ${profile.startUrl ?? "なし"})`,
          "",
        ]
      : []),
    ...(role === "implementer" && task.reviewRounds > 0 && lastBounce(ctx.db, task.id)
      ? ["## 直近の差し戻しの理由(最優先で解消する。同じ理由で2回差し戻されると人に回ります)", `- ${lastBounce(ctx.db, task.id)!.summary}`, ""]
      : []),
    "## 今回やること",
    ...ROLE_INSTRUCTIONS[role],
    ...extra,
    "",
  ].join("\n");
}

const ROLE_INSTRUCTIONS: Record<PromptRole, string[]> = {
  planner: [
    "- 成果物ディレクトリに `plan.md` を書き、判定を返してください。人のコメントがあれば、それを反映して計画を直してください",
    "- 実装の前に設計者・デザイナーを動かすべきかを `design` で判定してください(構造やインターフェースの判断があれば設計者、画面・見た目・操作の流れが変わるならデザイナー)",
    "- 複数リポジトリのプロジェクトでは、変更するリポジトリの役目を、実装する順に `repos` で返してください(API を先に、画面を後に、など)。片方だけで済むならそれだけ。2つ以上なら設計者がインターフェース契約を書きます",
  ],
  architect: ["- `plan.md` と既存のコードを読み、成果物ディレクトリに `design.md` を書いてください。コードは変更しないでください"],
  designer: ["- `plan.md`(と、あれば `design.md`)と既存の UI を読み、成果物ディレクトリに `ui-spec.md` を書いてください。コードは変更しないでください"],
  implementer: [
    "- `plan.md` に沿って(`design.md` / `ui-spec.md` があればそれにも沿って)、テスト先行で実装し、worktree にコミットしてください。成果物ディレクトリに `impl-notes.md` を書いてください",
    "- 差し戻しの場合は、レビュー結果・QA結果・テストの再実行結果・人のコメントの指摘をすべて解消してください。ただし、監査結果(audit.md)で invalid とされたレビューの指摘は対応不要です(理由は audit.md にあります)",
  ],
  reviewer: [
    "- ベースからの差分をレビューし、成果物ディレクトリに `review.md` を書いてください。指摘には重大度(must / should / nit)を付けてください",
    "- `design.md` / `ui-spec.md` があれば、実装がそれと食い違っていないかも確認してください",
  ],
  retrospective: [
    "- このタスクの記録を読み、次のタスクで同じ指摘や手戻りを繰り返さないための提案を、成果物ディレクトリの `retro.md` と構造化出力の `proposals` に書いてください。コードは変更しないでください",
    "- 今の規約(プロファイル)と設計判断ログ(decisions.md)にすでにあるものは提案しないでください",
  ],
  auditor: ["- 下の Must 指摘を、実際のコードを読んで1件ずつ検証し、成果物ディレクトリに `audit.md` を書いてください。コードは変更しないでください"],
  qa: [
    "- 受け入れ条件を動くアプリで確認し、成果物ディレクトリに `qa-report.md` を書いてください",
    "- `ui-spec.md` があるときは、実装後のデザインレビューのために、変更された画面のパス(起動 URL からの相対。例 `/tasks/1`)を構造化出力の `screens` に入れてください(撮影はツールが行います)",
  ],
  design_reviewer: ["- 下のスクリーンショットを Read で見て、`ui-spec.md` とデザイン方針に照らし、成果物ディレクトリに `design-review.md` を書いてください"],
  integrator: ["- 成果物ディレクトリに `pr-draft.md` を書いてください。git の操作は行わないでください"],
};
