import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addArtifact, addEvent, createTask, finishRun, startRun, updateTaskState } from "../src/db/store.ts";
import { taskDir } from "../src/orchestrator/paths.ts";
import { buildTaskReport } from "../src/orchestrator/report.ts";
import { testContext } from "./helpers/context.ts";
import { approvedProject } from "./helpers/project.ts";
import { ScriptedRunner } from "./helpers/scripted-runner.ts";

async function setup() {
  const ctx = testContext(new ScriptedRunner({}));
  const { project } = await approvedProject(ctx);
  const t = createTask(ctx.db, { projectId: project.id, title: "注文の一覧に状態を表示する", body: "本文", sourceKind: "paste", sourceUrl: "https://www.notion.so/team/abc123" });
  const dir = taskDir(ctx.home, t.id);
  mkdirSync(dir, { recursive: true });
  const artifact = (kind: string, verdict: string, body: string) => {
    const path = join(dir, `${kind}.md`);
    writeFileSync(path, `---\nverdict: ${verdict}\n---\n\n${body}`);
    addArtifact(ctx.db, { taskId: t.id, kind, path, verdict });
  };
  return { ctx, t, artifact };
}

describe("Notion に貼る報告(6c、API なし)", () => {
  it("節ごとに Markdown を組み立てる: 概要(元のページ・状態)、受け入れ条件、QA の結果、デザインレビュー、PR の下書き", async () => {
    const { ctx, t, artifact } = await setup();
    addEvent(ctx.db, { taskId: t.id, kind: "plan", payload: { acceptanceCriteria: ["各行に状態を表示する", "ライト / ダークで読める"] } });
    artifact("qa-report", "passed", "# QA レポート\n\n| # | 条件 | 結果 |\n|---|---|---|\n| 1 | 状態の表示 | 合格 |\n");
    artifact("design-review", "approve", "# デザインレビュー\n\n指摘なし\n");
    const run = startRun(ctx.db, { taskId: t.id, role: "design_reviewer" });
    finishRun(ctx.db, run.id, { state: "succeeded", verdict: "approve", summary: "must の指摘なし。ライト / ダークとも読める" });
    artifact("pr-draft", "done", "# 注文の一覧に状態を表示する\n\n## 変更点\n- 状態のラベル\n");
    updateTaskState(ctx.db, t.id, { state: "done" });

    const r = buildTaskReport(ctx.db, t.id);
    expect(r.sections.map((s) => s.id)).toEqual(["summary", "criteria", "qa", "design", "pr"]);
    const md = (id: string) => r.sections.find((s) => s.id === id)!.markdown;
    expect(md("summary")).toContain("注文の一覧に状態を表示する");
    expect(md("summary")).toContain("https://www.notion.so/team/abc123");
    expect(md("summary")).toContain("完了");
    expect(md("criteria")).toContain("- [x] 各行に状態を表示する");
    expect(md("qa")).toContain("合格");
    expect(md("qa")).toContain("| 1 | 状態の表示 | 合格 |");
    expect(md("qa")).not.toContain("verdict:"); // frontmatter は出さない
    expect(md("qa")).not.toContain("# QA レポート"); // 成果物の見出しは節の見出しに置き換える
    expect(md("design")).toContain("must の指摘なし");
    expect(md("pr")).toContain("## 変更点");
    // 全体は、節を順につないだもの
    expect(r.markdown).toBe(r.sections.map((s) => s.markdown).join("\n\n"));
    expect(r.sourceUrl).toBe("https://www.notion.so/team/abc123");
  });

  it("まだ無い成果物の節は出さない。QA が終わっていなければ受け入れ条件は未チェック", async () => {
    const { ctx, t } = await setup();
    addEvent(ctx.db, { taskId: t.id, kind: "plan", payload: { acceptanceCriteria: ["a"] } });
    const r = buildTaskReport(ctx.db, t.id);
    expect(r.sections.map((s) => s.id)).toEqual(["summary", "criteria"]);
    expect(r.sections[1]!.markdown).toContain("- [ ] a");
  });

  it("無いタスクはエラー", async () => {
    const { ctx } = await setup();
    expect(() => buildTaskReport(ctx.db, 999)).toThrow(/999/);
  });
});
