import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask, listEvents } from "../src/db/store.ts";
import { latestNeedsInputReason, runUntilIdle } from "../src/orchestrator/engine.ts";
import { approveTask, humanNotesPath, resolveDesignReview } from "../src/orchestrator/human.ts";
import { nextActions } from "../src/orchestrator/next-actions.ts";
import type { CaptureFn } from "../src/orchestrator/context.ts";
import { testContext } from "./helpers/context.ts";
import { sh } from "./helpers/gitrepo.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";

const planner = answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false, design: { architect: false, designer: true, reason: "画面が変わる" } });
const designer = answer("ui-spec.md", "ready", { decisions: [] });
const implementer: Script = (spec) => {
  writeFileSync(join(spec.cwd, "ui.js"), `export const v = ${Date.now()};\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...spec.extraEnv };
  sh(spec.cwd, "git", ["add", "."], env);
  sh(spec.cwd, "git", ["commit", "-q", "-m", "画面を直す"], env);
  writeArtifact(spec, "impl-notes.md", "done");
  return { structuredOutput: { verdict: "done", summary: "s", testCommand: null } };
};
const verifier: Script = () => ({ structuredOutput: { verdict: "passed", summary: "s" }, bashResults: [{ command: "npm test", isError: false, output: "ok" }] });
const reviewer = answer("review.md", "approve", { findings: [] });
const qa = answer("qa-report.md", "passed", { screens: [{ path: "/items", note: "在庫一覧" }] });

/** 撮影の代わり(実際の Chrome は使わない)。呼ばれた画面を記録し、小さな PNG を書く */
function fakeCapture(calls: { path: string }[][], fail = false): CaptureFn {
  return async (_ctx, _task, o) => {
    calls.push(o.screens);
    if (fail) throw new Error("起動コマンドがありません");
    mkdirSync(o.outDir, { recursive: true });
    return o.screens.flatMap((s, i) =>
      (["light", "dark"] as const).map((scheme) => {
        const file = `s${i + 1}-1280-${scheme}.png`;
        writeFileSync(join(o.outDir, file), "png");
        return { name: `s${i + 1}`, path: s.path, width: 1280, scheme, file };
      }),
    );
  };
}

async function toQa(scripts: Record<string, Script>, capture: CaptureFn) {
  const runner = new ScriptedRunner({ planner, designer, implementer, verifier, reviewer, qa, ...scripts });
  const ctx = testContext(runner);
  ctx.capture = capture;
  const { project } = await approvedProject(ctx);
  const t = newTask(ctx, project.id);
  await runUntilIdle(ctx);
  approveTask(ctx, t.id, "plan");
  await runUntilIdle(ctx);
  approveTask(ctx, t.id, "design");
  await runUntilIdle(ctx);
  return { ctx, runner, t };
}

describe("デザインレビュー(4c)", () => {
  it("QA が返した画面をツールが撮り、デザインレビュー担当が画像と ui-spec.md を見比べる。approve で最終確認待ちへ", async () => {
    const calls: { path: string }[][] = [];
    let prompt = "";
    const { ctx, runner, t } = await toQa(
      {
        design_reviewer: (spec, n) => {
          prompt = spec.prompt;
          return answer("design-review.md", "approve")(spec, n);
        },
      },
      fakeCapture(calls),
    );
    expect(calls).toEqual([[{ path: "/items", note: "在庫一覧" }]]);
    expect(runner.rolesCalled().slice(-2)).toEqual(["qa", "design_reviewer"]);
    expect(prompt).toContain("s1-1280-light.png");
    expect(prompt).toContain("ui-spec.md");
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
    expect(listEvents(ctx.db, t.id).find((e) => e.kind === "screens")?.payload).toMatchObject({ shots: [expect.objectContaining({ file: "s1-1280-light.png" }), expect.anything()] });
  });

  it("changes_requested は実装へ差し戻す", async () => {
    let n = 0;
    const { ctx, t } = await toQa(
      { design_reviewer: (spec) => answer("design-review.md", n++ === 0 ? "changes_requested" : "approve")(spec, 0) },
      fakeCapture([]),
    );
    expect(n).toBe(2); // 差し戻し → 実装 → … → もう一度デザインレビュー
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "awaiting_final_approval", reviewRounds: 1 });
  });

  it("撮影できなければ、デザインレビューを飛ばさず人の判断待ちにする", async () => {
    const { ctx, runner, t } = await toQa({ design_reviewer: answer("design-review.md", "approve") }, fakeCapture([], true));
    expect(runner.rolesCalled()).not.toContain("design_reviewer");
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "design_reviewing" });
    expect(latestNeedsInputReason(ctx.db, t.id)).toContain("撮影");
  });

  it("QA が画面を返さなければ、起動 URL のトップを撮る", async () => {
    const calls: { path: string }[][] = [];
    await toQa({ qa: answer("qa-report.md", "passed"), design_reviewer: answer("design-review.md", "approve") }, fakeCapture(calls));
    expect(calls[0]).toEqual([{ path: "/", note: "トップ(QA が撮る画面を返さなかったため)" }]);
  });
});

describe("デザインレビューを行わないとき・撮影できなかったときの出口", () => {
  it("デザイナーが「UI は変わらない」(uiChanges: false)と返したら、撮影もデザインレビューもしない", async () => {
    const calls: { path: string }[][] = [];
    const { ctx, runner, t } = await toQa(
      { designer: answer("ui-spec.md", "ready", { decisions: [], uiChanges: false }), design_reviewer: answer("design-review.md", "approve") },
      fakeCapture(calls),
    );
    expect(calls).toEqual([]);
    expect(runner.rolesCalled()).not.toContain("design_reviewer");
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
  });

  it("撮影できずに止まったら、回答のほかに「飛ばして最終確認へ」「実装者に差し戻す」を選べる", async () => {
    const { ctx, t } = await toQa({ design_reviewer: answer("design-review.md", "approve") }, fakeCapture([], true));
    const kinds = nextActions(ctx.db, getTask(ctx.db, t.id)!).map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["answer", "skip_design_review", "back_to_implementer"]));
    resolveDesignReview(ctx, t.id, "skip", "UI は変わらない");
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
    expect(readFileSync(humanNotesPath(ctx.home, t.id), "utf8")).toContain("UI は変わらない");
  });

  it("実装者に差し戻すと、理由を残して実装からやり直す", async () => {
    const { ctx, t } = await toQa({ design_reviewer: answer("design-review.md", "approve") }, fakeCapture([], true));
    resolveDesignReview(ctx, t.id, "implementer", "screens_test.dart を書いてください");
    expect(getTask(ctx.db, t.id)!.state).toBe("implementing");
    expect(readFileSync(humanNotesPath(ctx.home, t.id), "utf8")).toContain("screens_test.dart を書いてください");
    expect(() => resolveDesignReview(ctx, t.id, "skip")).toThrow();
  });
});

describe("テスト基盤整備では設計者・デザイナーを動かさない", () => {
  it("計画の承認に、設計者・デザイナーのチェックを出さない", async () => {
    const { createTask, setTaskDesign, updateTaskState } = await import("../src/db/store.ts");
    const ctx = testContext(new ScriptedRunner({}));
    const { project } = await approvedProject(ctx);
    const t = createTask(ctx.db, { projectId: project.id, kind: "test_infra", title: "テスト基盤整備", body: "b" });
    updateTaskState(ctx.db, t.id, { state: "awaiting_plan_approval" });
    setTaskDesign(ctx.db, t.id, { architect: false, designer: true });
    const approve = nextActions(ctx.db, getTask(ctx.db, t.id)!).find((a) => a.kind === "approve")!;
    expect(approve.options).toBeUndefined();
  });
});

describe("最終確認の操作", () => {
  it("承認・却下のほかに、エディタで開く(worktree を見るだけ)を出す", async () => {
    const { ctx, t } = await toQa({ design_reviewer: answer("design-review.md", "approve") }, fakeCapture([]));
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
    expect(nextActions(ctx.db, getTask(ctx.db, t.id)!).map((a) => a.kind)).toEqual(["approve", "reject", "open_editor"]);
  });
});
