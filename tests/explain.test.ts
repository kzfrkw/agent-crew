import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTask, listArtifacts, listEvents, setProjectSettingsRow } from "../src/db/store.ts";
import { runUntilIdle } from "../src/orchestrator/engine.ts";
import { approveTask } from "../src/orchestrator/human.ts";
import { projectDir, taskDir } from "../src/orchestrator/paths.ts";
import { testContext } from "./helpers/context.ts";
import { devScripts } from "./helpers/dev-scripts.ts";
import { approvedProject, newTask } from "./helpers/project.ts";
import { ScriptedRunner, writeArtifact, type Script } from "./helpers/scripted-runner.ts";

/**
 * 最終確認の前に、変更の解説(explain.md)を作る(v0.24)。人が変更を理解してから承認できるように、
 * 重要なロジックと、使っている技術の解説を書く。用語集はプロジェクトごとに溜め、一度説明した用語は次から短くする
 */

const explainer =
  (terms: { term: string; explanation: string }[] = [{ term: "ページング", explanation: "一覧を一定件数ずつに分けて返すこと" }]): Script =>
  (spec) => {
    writeArtifact(spec, "explain.md", "done", "# 解説\\n\\n## 変更の要点");
    return { structuredOutput: { verdict: "done", summary: "s", terms } };
  };

async function setup(over: Record<string, Script> = {}) {
  const runner = new ScriptedRunner(devScripts({ explainer: explainer(), ...over }));
  const ctx = testContext(runner);
  const p = await approvedProject(ctx);
  return { ctx, runner, ...p };
}

async function toFinal(ctx: Awaited<ReturnType<typeof setup>>["ctx"], id: number) {
  await runUntilIdle(ctx);
  approveTask(ctx, id, "plan");
  await runUntilIdle(ctx);
}

describe("解説担当", () => {
  it("QA の合格の後、最終確認の前に解説を作る。差分はファイルにして渡し、コードは変えない", async () => {
    const { ctx, runner, project } = await setup();
    const t = newTask(ctx, project.id);
    await toFinal(ctx, t.id);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
    const roles = runner.rolesCalled();
    expect(roles.indexOf("explainer")).toBe(roles.indexOf("qa") + 1);
    const call = runner.calls.find((c) => c.role === "explainer")!;
    expect(call.write).toBe("artifacts");
    expect(call.tools).not.toContain("Bash");
    const diff = join(taskDir(ctx.home, t.id), "explain-diff.patch");
    expect(call.prompt).toContain(diff);
    expect(readFileSync(diff, "utf8")).toContain("f0.js");
    // 初めての人向けに書く
    expect(call.prompt).toContain("初めて");
    expect(listArtifacts(ctx.db, t.id).map((a) => a.kind)).toContain("explain");
  });

  it("新しい用語はプロジェクトの用語集に足す。次の解説では用語集を渡し、同じ用語は足さない", async () => {
    const { ctx, runner, project } = await setup({
      explainer: explainer([
        { term: "ページング", explanation: "一覧を一定件数ずつに分けて返すこと" },
        { term: "オフセット", explanation: "先頭から何件飛ばすか" },
      ]),
    });
    const a = newTask(ctx, project.id, "a");
    await toFinal(ctx, a.id);
    const glossary = join(projectDir(ctx.home, project.id), "glossary.md");
    const first = readFileSync(glossary, "utf8");
    expect(first).toContain("ページング");
    expect(first).toContain("先頭から何件飛ばすか");
    approveTask(ctx, a.id, "final");
    await runUntilIdle(ctx);
    const b = newTask(ctx, project.id, "b");
    await toFinal(ctx, b.id);
    expect(runner.calls.filter((c) => c.role === "explainer")[1]!.prompt).toContain(glossary);
    expect(readFileSync(glossary, "utf8").match(/ページング/g)).toHaveLength(1);
  });

  it("解説担当が失敗しても止めずに最終確認へ進み、作れなかったことを残す", async () => {
    const { ctx, project } = await setup({ explainer: () => ({ structuredOutput: { verdict: "done", summary: "s", terms: [] } }) });
    const t = newTask(ctx, project.id);
    await toFinal(ctx, t.id);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
    expect(String((listEvents(ctx.db, t.id).find((e) => e.kind === "explain_failed")!.payload as { reason: string }).reason)).toContain("explain.md");
  });

  it("プロジェクトの設定でオフにすると作らない", async () => {
    const { ctx, runner, project } = await setup();
    setProjectSettingsRow(ctx.db, project.id, { explain: false });
    const t = newTask(ctx, project.id);
    await toFinal(ctx, t.id);
    expect(getTask(ctx.db, t.id)!.state).toBe("awaiting_final_approval");
    expect(runner.rolesCalled()).not.toContain("explainer");
    expect(existsSync(join(taskDir(ctx.home, t.id), "explain.md"))).toBe(false);
  });
});
