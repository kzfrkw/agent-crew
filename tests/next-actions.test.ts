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
    expect(a[0]).toMatchObject({
      command: `agent-crew task approve ${task.id} --kind plan`,
      request: { action: "approve", kind: "plan" },
      input: { field: "comment", required: false },
      primary: true,
    });
    expect(a[1]).toMatchObject({ request: { action: "reject", kind: "plan" }, input: { field: "comment", required: true } });
    expect(a[1]!.command).toContain("--kind plan --comment");
  });

  it("計画の承認: 設計者・デザイナーを動かすかを、プランナーの判定を初期値に選べる(理由も添える)", () => {
    const { db, task } = setup("awaiting_plan_approval");
    updateTaskState(db, task.id, { state: "awaiting_plan_approval", design: { architect: true, designer: false } });
    addEvent(db, { taskId: task.id, kind: "plan", payload: { design: { architect: true, designer: false, reason: "モジュールを分けるため" } } });
    const a = nextActions(db, { ...task, design: { architect: true, designer: false } })[0]!;
    expect(a.options).toEqual([
      { key: "architect", label: expect.stringContaining("設計者"), value: true },
      { key: "designer", label: expect.stringContaining("デザイナー"), value: false },
    ]);
    expect(a.optionsNote).toContain("モジュールを分けるため");
  });

  it("デザイン仕様の承認待ち: 承認と却下(kind は design)", () => {
    const { db, task } = setup("awaiting_design_approval");
    expect(attentionOf(task)).toBe("approve_design");
    const a = nextActions(db, task);
    expect(a.map((x) => x.request)).toEqual([
      { action: "approve", kind: "design" },
      { action: "reject", kind: "design", comment: "" },
    ]);
    expect(a[0]!.command).toBe(`agent-crew task approve ${task.id} --kind design`);
  });

  it("最終確認待ち", () => {
    const { db, task } = setup("awaiting_final_approval");
    expect(attentionOf(task)).toBe("approve_final");
    expect(nextActions(db, task)[0]!.command).toBe(`agent-crew task approve ${task.id} --kind final`);
  });

  it("回答待ち: 回答と引き取り", () => {
    const { db, task } = setup("needs_input", "planning");
    expect(attentionOf(task)).toBe("answer");
    const a = nextActions(db, task);
    expect(a.map((x) => x.kind)).toEqual(["answer", "takeover", "update_base", "cancel"]);
    expect(a[0]).toMatchObject({ request: { action: "answer" }, input: { field: "message", required: true }, primary: true });
    expect(a[3]!.confirm).toBeTruthy();
  });

  it("人が作業中: 戻す", () => {
    const { db, task } = setup("human_working", "implementing");
    expect(attentionOf(task)).toBe("human_working");
    expect(nextActions(db, task)).toEqual([
      expect.objectContaining({ kind: "return", command: `agent-crew task return ${task.id}`, request: { action: "return" }, primary: true }),
      expect.objectContaining({ kind: "open_editor", command: null, request: { action: "open_editor" } }),
    ]);
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
    expect(nextActions(db, task)).toEqual([expect.objectContaining({ kind: "push", command: "git -C /r/shop push origin ac/1-x", request: null })]);
  });

  it("エージェントの実行中は停止だけ(確認つき。CLI では Ctrl-C なのでコマンドは無い)", () => {
    const { db, task } = setup("implementing");
    startRun(db, { taskId: task.id, role: "implementer" });
    expect(attentionOf(task)).toBeNull();
    expect(nextActions(db, task)).toEqual([expect.objectContaining({ kind: "stop", command: null, request: { action: "stop" }, confirm: expect.any(String) })]);
  });

  it("進行中で実行していないとき(待機中など)は何もしない", () => {
    const { db, task } = setup("implementing");
    expect(nextActions(db, task)).toEqual([]);
  });
});
