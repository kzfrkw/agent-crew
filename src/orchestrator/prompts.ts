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
