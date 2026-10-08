import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/connection.ts";
import { addEvent, createProject, createTask, startRun, updateTaskState } from "../src/db/store.ts";
import { attentionOf, nextActions } from "../src/orchestrator/next-actions.ts";
import type { TaskState } from "../src/orchestrator/states.ts";

function setup(state: TaskState, held: TaskState | null = null) {
  const db = openDb(":memory:");
  const p = createProject(db, { name: "shop" });
  const t = createTask(db, { projectId: p.id, title: "t", body: "" });
  updateTaskState(db, t.id, { state, heldFromState: held });
  return { db, task: { ...t, state, heldFromState: held } };
}

describe("next-actions", () => {
  it("計画の承認待ち: 承認と却下", () => {
    const { db, task } = setup("awaiting_plan_approval");
    expect(attentionOf(task)).toBe("approve_plan");
    const a = nextActions(db, task);
    expect(a.map((x) => x.kind)).toEqual(["approve", "reject"]);
    expect(a[0]!.command).toBe(`agent-crew task approve ${task.id} --kind plan`);
    expect(a[1]!.command).toContain("--kind plan --comment");
  });

  it("最終確認待ち", () => {
    const { db, task } = setup("awaiting_final_approval");
    expect(attentionOf(task)).toBe("approve_final");
    expect(nextActions(db, task)[0]!.command).toBe(`agent-crew task approve ${task.id} --kind final`);
  });

  it("回答待ち: 回答と引き取り", () => {
    const { db, task } = setup("needs_input", "planning");
    expect(attentionOf(task)).toBe("answer");
    expect(nextActions(db, task).map((x) => x.kind)).toEqual(["answer", "takeover"]);
  });

  it("人が作業中: 戻す", () => {
    const { db, task } = setup("human_working", "implementing");
    expect(attentionOf(task)).toBe("human_working");
    expect(nextActions(db, task)).toEqual([expect.objectContaining({ kind: "return", command: `agent-crew task return ${task.id}` })]);
  });

  it("失敗: 引き取りと取り消し", () => {
    const { db, task } = setup("failed", "qa");
    expect(attentionOf(task)).toBe("failed");
    expect(nextActions(db, task).map((x) => x.kind)).toEqual(["takeover", "cancel"]);
  });

  it("完了: push のコマンド(人が行う)", () => {
    const { db, task } = setup("done");
    addEvent(db, { taskId: task.id, kind: "integrated", payload: { repo: "/r/shop", branch: "ac/1-x" } });
    expect(attentionOf(task)).toBeNull();
    expect(nextActions(db, task)).toEqual([expect.objectContaining({ kind: "push", command: "git -C /r/shop push origin ac/1-x" })]);
  });

  it("エージェントの実行中は何もしない", () => {
    const { db, task } = setup("implementing");
    startRun(db, { taskId: task.id, role: "implementer" });
    expect(attentionOf(task)).toBeNull();
    expect(nextActions(db, task)).toEqual([]);
  });
});
