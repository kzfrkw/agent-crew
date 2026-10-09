import type { Db } from "../db/connection.ts";
import { listEvents, type Task } from "../db/store.ts";
import type { Attention, NextAction } from "../server/api-types.ts";
import { runActive } from "./engine.ts";

/**
 * 状態ごとに「人が次にすること」。CLI の task show と GUI が共有する(設計メモ14章 v0.8)。
 * フェーズ2では CLI コマンドを示し、フェーズ3ではこれがボタンになる。
 */

/** 人の対応が必要な理由の種類(不要なら null) */
export function attentionOf(task: Pick<Task, "state">): Attention | null {
  switch (task.state) {
    case "awaiting_plan_approval":
      return "approve_plan";
    case "awaiting_final_approval":
      return "approve_final";
    case "needs_input":
      return "answer";
    case "failed":
      return "failed";
    case "human_working":
      return "human_working";
    default:
      return null;
  }
}

export function nextActions(db: Db, task: Pick<Task, "id" | "state">): NextAction[] {
  const id = task.id;
  if (runActive(db, id)) {
    return [{ kind: "stop", label: "実行中の役割を停止する", command: null, request: { action: "stop" }, confirm: "実行中の claude を止めます。タスクは人の判断待ちになります" }];
  }
  const approval = (kind: "plan" | "final", what: string): NextAction[] => [
    {
      kind: "approve",
      label: `${what}を確認して承認する`,
      command: `agent-crew task approve ${id} --kind ${kind}`,
      request: { action: "approve", kind },
      input: { field: "comment", required: false, placeholder: "コメント(任意。次の役割への入力になります)" },
      primary: true,
    },
    {
      kind: "reject",
      label: "却下して差し戻す",
      command: `agent-crew task reject ${id} --kind ${kind} --comment "..."`,
      request: { action: "reject", kind, comment: "" },
      input: { field: "comment", required: true, placeholder: "却下の理由(次の役割への入力になります)" },
    },
  ];
  const takeover: NextAction = {
    kind: "takeover",
    label: "人が引き取って worktree で作業する",
    command: `agent-crew task takeover ${id}`,
    request: { action: "takeover" },
  };
  const cancel: NextAction = {
    kind: "cancel",
    label: "取り消す",
    command: `agent-crew task cancel ${id}`,
    request: { action: "cancel" },
    confirm: "タスクを取り消します(worktree とブランチは残ります)",
  };
  switch (task.state) {
    case "awaiting_plan_approval":
      return approval("plan", "plan.md ");
    case "awaiting_final_approval":
      return approval("final", "成果物");
    case "needs_input":
      return [
        {
          kind: "answer",
          label: "回答して再開する",
          command: `agent-crew task answer ${id} --message "..."`,
          request: { action: "answer", message: "" },
          input: { field: "message", required: true, placeholder: "回答(次の役割への入力になります)" },
          primary: true,
        },
        takeover,
        { kind: "update_base", label: "ベースを取り込む", command: `agent-crew task update-base ${id}`, request: { action: "update_base" } },
        cancel,
      ];
    case "human_working":
      return [
        { kind: "return", label: "作業をコミットしてからエージェントに戻す", command: `agent-crew task return ${id}`, request: { action: "return" }, primary: true },
        { kind: "open_editor", label: "エディタで開く", command: null, request: { action: "open_editor" } },
      ];
    case "failed":
      return [{ ...takeover, primary: true }, cancel];
    case "done":
      return listEvents(db, id, 1000)
        .filter((e) => e.kind === "integrated")
        .map((e) => {
          const p = e.payload as { repo: string; branch: string };
          return { kind: "push", label: "push と PR 作成は人が行います(PR本文の下書き: pr-draft.md)", command: `git -C ${p.repo} push origin ${p.branch}`, request: null };
        });
    default:
      return [];
  }
}
