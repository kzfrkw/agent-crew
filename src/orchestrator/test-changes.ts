/**
 * テストの変更の検出(純粋関数)。レビュワーがテストの差分を重点確認するための材料を作る(設計メモ4章「自己採点の防止」)。
 * 機械的な検出なので誤検知はありうる。判断はレビュワーが行う。
 */

const TEST_FILE = [
  /(^|\/)(test|tests|__tests__|spec|specs)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.(go|py|dart)$/,
  /(^|\/)test_[^/]*\.py$/,
  /Tests?\.swift$/,
];
const ASSERTION = /\b(assert\w*|expect|XCTAssert\w*|should|require\.\w+)\s*[.(]/;
const SKIP = /\b(x(it|describe|test)\s*\(|(it|test|describe)\.(skip|only|todo)\s*\(|pytest\.mark\.skip|t\.Skip\(|XCTSkip)|@skip\b|\bskip:\s*true/;
const NOT_CODE = /\.(md|txt|json|ya?ml|lock|toml|ini|cfg)$|(^|\/)(LICENSE|CHANGELOG)/i;

export function isTestFile(path: string): boolean {
  return TEST_FILE.some((re) => re.test(path));
}

export type NameStatus = { status: string; path: string };
export type Finding = { file: string; line: string };
export type TestChanges = {
  added: string[];
  modified: string[];
  deleted: string[];
  removedAssertions: Finding[];
  addedSkips: Finding[];
  warnings: string[];
};

export function detectTestChanges(o: { nameStatus: NameStatus[]; diff: string }): TestChanges {
  const tests = o.nameStatus.filter((n) => isTestFile(n.path));
  const added = tests.filter((n) => n.status.startsWith("A")).map((n) => n.path);
  const modified = tests.filter((n) => n.status.startsWith("M") || n.status.startsWith("R")).map((n) => n.path);
  const deleted = tests.filter((n) => n.status.startsWith("D")).map((n) => n.path);

  const removedAssertions: Finding[] = [];
  const addedSkips: Finding[] = [];
  let file = "";
  for (const raw of o.diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.replace(/^\+\+\+ (b\/)?/, "");
      continue;
    }
    if (raw.startsWith("--- ")) {
      if (raw !== "--- /dev/null") file = raw.replace(/^--- (a\/)?/, "");
      continue;
    }
    if (!isTestFile(file)) continue;
    const line = raw.slice(1).trim();
    if (raw.startsWith("-") && ASSERTION.test(line)) removedAssertions.push({ file, line });
    if (raw.startsWith("+") && SKIP.test(line)) addedSkips.push({ file, line });
  }

  const warnings: string[] = [];
  if (deleted.length) warnings.push(`テストファイルが削除されています: ${deleted.join(", ")}`);
  if (removedAssertions.length) warnings.push(`アサーションを削除・変更した行が ${removedAssertions.length} 件あります`);
  if (addedSkips.length) warnings.push(`スキップ・フォーカス(.skip / .only など)を追加した行が ${addedSkips.length} 件あります`);
  const codeChanged = o.nameStatus.some((n) => !isTestFile(n.path) && !NOT_CODE.test(n.path));
  if (codeChanged && added.length + modified.length === 0) warnings.push("実装が変わっていますが、テストの変更がありません");
  return { added, modified, deleted, removedAssertions, addedSkips, warnings };
}

export function renderTestChanges(c: TestChanges): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- なし");
  const findings = (items: Finding[]) => (items.length ? items.map((f) => `- ${f.file}: \`${f.line}\``).join("\n") : "- なし");
  return `# テストの変更の検出結果(機械的な検出。判断はレビュワーが行う)

## 注意点
${list(c.warnings)}

## 追加されたテストファイル
${list(c.added)}

## 変更されたテストファイル
${list(c.modified)}

## 削除されたテストファイル
${list(c.deleted)}

## 削除・変更されたアサーション
${findings(c.removedAssertions)}

## 追加されたスキップ・フォーカス
${findings(c.addedSkips)}
`;
}
