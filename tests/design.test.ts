import { describe, expect, it } from "vitest";
import { getTask } from "../src/db/store.ts";
import { runUntilIdle } from "../src/orchestrator/engine.ts";
import { approveTask } from "../src/orchestrator/human.ts";
import { testContext } from "./helpers/context.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { answer, ScriptedRunner } from "./helpers/scripted-runner.ts";

const planner = (architect: boolean, designer: boolean) =>
  answer("plan.md", "ready", { acceptanceCriteria: ["a"], testFirstException: false, design: { architect, designer, reason: "理由" } });

describe("設計の段の判定(フェーズ4)", () => {
  it("タスクの既定は、設計者もデザイナーも動かさない", async () => {
    const ctx = testContext(new ScriptedRunner({}));
    const { project } = await approvedProject(ctx);
    expect(newTask(ctx, project.id).design).toEqual({ architect: false, designer: false });
  });

  it("プランナーの判定をタスクに保存する", async () => {
    const ctx = testContext(new ScriptedRunner({ planner: planner(true, false) }));
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    await runUntilIdle(ctx);
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "awaiting_plan_approval", design: { architect: true, designer: false } });
  });

  it("計画の承認で上書きした判定を保存し、設計の段に進む", async () => {
    const ctx = testContext(new ScriptedRunner({ planner: planner(false, false) }));
    const { project } = await approvedProject(ctx);
    const t = newTask(ctx, project.id);
    await runUntilIdle(ctx);
    approveTask(ctx, t.id, "plan", undefined, { architect: false, designer: true });
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "designing", design: { architect: false, designer: true } });
  });
});

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { listRuns } from "../src/db/store.ts";
import { stepTask } from "../src/orchestrator/engine.ts";
import { rejectTask } from "../src/orchestrator/human.ts";
import { projectDir } from "../src/orchestrator/paths.ts";
import { writeArtifact, type Script } from "./helpers/scripted-runner.ts";

const architectReady: Script = (spec) => {
  writeArtifact(spec, "design.md", "ready", "# 設計");
  return { structuredOutput: { verdict: "ready", summary: "設計しました", decisions: ["一覧のフィルタは items.js に閉じ込める"] } };
};
const designerReady: Script = (spec) => {
  writeArtifact(spec, "ui-spec.md", "ready", "# UI仕様");
  return { structuredOutput: { verdict: "ready", summary: "UI仕様を書きました", decisions: [] } };
};

/** 計画の承認まで進めたタスク */
async function approvedPlan(scripts: Record<string, Script>, design: { architect: boolean; designer: boolean }) {
  const runner = new ScriptedRunner({ planner: planner(design.architect, design.designer), ...scripts });
  const ctx = testContext(runner);
  const { project } = await approvedProject(ctx);
  const t = newTask(ctx, project.id);
  await runUntilIdle(ctx);
  approveTask(ctx, t.id, "plan");
  return { ctx, runner, t, project };
}

describe("設計の段のハンドラー", () => {
  it("設計者だけ: design.md を書かせて実装へ。残すべき判断は設計判断ログにコードが追記する", async () => {
    const { ctx, runner, t, project } = await approvedPlan({ architect: architectReady }, { architect: true, designer: false });
    await stepTask(ctx, t.id);
    expect(runner.rolesCalled()).toEqual(["planner", "architect"]);
    expect(getTask(ctx.db, t.id)!.state).toBe("implementing");
    const log = readFileSync(join(projectDir(ctx.home, project.id), "decisions.md"), "utf8");
    expect(log).toContain(`#${t.id}`);
    expect(log).toContain("一覧のフィルタは items.js に閉じ込める");
  });

  it("両方: 設計者 → デザイナーの順に動かし(デザイナーは design.md を読む)、デザイン仕様の承認待ちへ", async () => {
    const { ctx, runner, t } = await approvedPlan({ architect: architectReady, designer: designerReady }, { architect: true, designer: true });
    await stepTask(ctx, t.id);
    expect(runner.rolesCalled()).toEqual(["planner", "architect", "designer"]);
    expect(runner.calls[2]!.prompt).toContain("design.md");
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_design_approval");
  });

  it("設計者が人の判断を求めたら、デザイナーは動かさない", async () => {
    const architectAsks: Script = (spec) => {
      writeArtifact(spec, "design.md", "need_human");
      return { structuredOutput: { verdict: "need_human", summary: "A案とB案を選んでください", decisions: [] } };
    };
    const { ctx, runner, t } = await approvedPlan({ architect: architectAsks, designer: designerReady }, { architect: true, designer: true });
    await stepTask(ctx, t.id);
    expect(runner.rolesCalled()).toEqual(["planner", "architect"]);
    expect(getTask(ctx.db, t.id)).toMatchObject({ state: "needs_input", heldFromState: "designing" });
  });

  it("デザイン仕様の却下: designing に戻り、人のコメントを読んで描き直す。承認で実装へ", async () => {
    const { ctx, runner, t } = await approvedPlan({ designer: designerReady }, { architect: false, designer: true });
    await stepTask(ctx, t.id);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_design_approval");
    rejectTask(ctx, t.id, "design", "ボタンは右寄せにしてください");
    expect(getTask(ctx.db, t.id)!.state).toBe("designing");
    await stepTask(ctx, t.id);
    expect(runner.rolesCalled()).toEqual(["planner", "designer", "designer"]);
    expect(runner.calls[2]!.prompt).toContain("human-notes.md");
    approveTask(ctx, t.id, "design");
    expect(getTask(ctx.db, t.id)!.state).toBe("implementing");
  });

  it("プロジェクトのデザイン方針(design-guide.md)があれば、デザイナーの入力に入れる", async () => {
    const { ctx, runner, t, project } = await approvedPlan({ designer: designerReady }, { architect: false, designer: true });
    mkdirSync(projectDir(ctx.home, project.id), { recursive: true });
    writeFileSync(join(projectDir(ctx.home, project.id), "design-guide.md"), "# デザイン方針\n");
    await stepTask(ctx, t.id);
    expect(runner.calls.at(-1)!.prompt).toContain("design-guide.md");
  });

  it("設計の成果物は、実装者の入力になる", async () => {
    const implementerSeen: string[] = [];
    const { ctx, t } = await approvedPlan(
      {
        architect: architectReady,
        designer: designerReady,
        implementer: (spec) => {
          implementerSeen.push(spec.prompt);
          return { status: "failed", error: "ここで止める" };
        },
      },
      { architect: true, designer: true },
    );
    await stepTask(ctx, t.id);
    approveTask(ctx, t.id, "design");
    await stepTask(ctx, t.id);
    expect(implementerSeen[0]).toContain("design.md");
    expect(implementerSeen[0]).toContain("ui-spec.md");
    expect(listRuns(ctx.db, { taskId: t.id }).map((r) => r.role)).toEqual(["planner", "architect", "designer", "implementer"]);
  });
});
