import { describe, expect, it } from "vitest";
import { detectTestChanges, isTestFile, renderTestChanges } from "../src/orchestrator/test-changes.ts";

describe("isTestFile", () => {
  it.each([
    ["test/items.test.js", true], ["src/a.spec.ts", true], ["__tests__/x.js", true], ["pkg/a_test.go", true],
    ["tests/test_api.py", true], ["AppTests/LoginTests.swift", true], ["test/widget_test.dart", true],
    ["src/items.js", false], ["README.md", false], ["src/testing-utils.ts", false],
  ])("%s → %s", (path, expected) => {
    expect(isTestFile(path)).toBe(expected);
  });
});

const diff = `diff --git a/test/items.test.js b/test/items.test.js
--- a/test/items.test.js
+++ b/test/items.test.js
@@ -1,6 +1,6 @@
 test("listItems", () => {
-  assert.equal(listItems().length, 3);
+  assert.ok(listItems());
 });
-test("findItem", () => {
+test.skip("findItem", () => {
   expect(findItem(1).name).toBe("りんご");
diff --git a/src/items.js b/src/items.js
--- a/src/items.js
+++ b/src/items.js
@@ -1,1 +1,1 @@
-export const a = 1;
+export const a = 2;
`;

describe("detectTestChanges", () => {
  it("削除されたアサーションと、追加されたスキップを見つける", () => {
    const r = detectTestChanges({
      nameStatus: [{ status: "M", path: "test/items.test.js" }, { status: "M", path: "src/items.js" }, { status: "D", path: "test/old.test.js" }],
      diff,
    });
    expect(r.modified).toEqual(["test/items.test.js"]);
    expect(r.deleted).toEqual(["test/old.test.js"]);
    expect(r.removedAssertions).toEqual([{ file: "test/items.test.js", line: "assert.equal(listItems().length, 3);" }]);
    expect(r.addedSkips).toEqual([{ file: "test/items.test.js", line: 'test.skip("findItem", () => {' }]);
    expect(r.warnings.join("\n")).toMatch(/削除/);
  });

  it("実装を変えたのにテストの変更が無ければ警告する", () => {
    const r = detectTestChanges({ nameStatus: [{ status: "M", path: "src/items.js" }], diff: "" });
    expect(r.warnings.join("\n")).toContain("テストの変更がありません");
  });

  it("テストを追加しただけなら警告なし", () => {
    const r = detectTestChanges({
      nameStatus: [{ status: "A", path: "test/new.test.js" }, { status: "M", path: "src/items.js" }],
      diff: "+++ b/test/new.test.js\n+  assert.equal(1, 1);\n",
    });
    expect(r).toMatchObject({ added: ["test/new.test.js"], warnings: [] });
  });

  it(".only(フォーカス)も検出する", () => {
    const r = detectTestChanges({
      nameStatus: [{ status: "M", path: "a.test.ts" }],
      diff: "+++ b/a.test.ts\n+it.only(\"x\", () => {})\n",
    });
    expect(r.addedSkips).toHaveLength(1);
  });

  it("Markdown にして渡せる", () => {
    const md = renderTestChanges(detectTestChanges({ nameStatus: [{ status: "D", path: "t.test.js" }], diff: "" }));
    expect(md).toContain("t.test.js");
    expect(md).toContain("削除");
  });
});
