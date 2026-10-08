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
  if (runActive(db, task.id)) return [];
  const id = task.id;
  const approval = (kind: "plan" | "final", what: string): NextAction[] => [
    { kind: "approve", label: `${what}を確認して承認する`, command: `agent-crew task approve ${id} --kind ${kind}` },
    { kind: "reject", label: "却下して差し戻す", command: `agent-crew task reject ${id} --kind ${kind} --comment "..."` },
  ];
  const takeover: NextAction = { kind: "takeover", label: "人が引き取って worktree で作業する", command: `agent-crew task takeover ${id}` };
  switch (task.state) {
    case "awaiting_plan_approval":
      return approval("plan", "plan.md ");
    case "awaiting_final_approval":
      return approval("final", "成果物");
    case "needs_input":
      return [{ kind: "answer", label: "回答して再開する", command: `agent-crew task answer ${id} --message "..."` }, takeover];
    case "human_working":
      return [{ kind: "return", label: "作業をコミットしてからエージェントに戻す", command: `agent-crew task return ${id}` }];
    case "failed":
      return [takeover, { kind: "cancel", label: "取り消す", command: `agent-crew task cancel ${id}` }];
    case "done":
      return listEvents(db, id, 1000)
        .filter((e) => e.kind === "integrated")
        .map((e) => {
          const p = e.payload as { repo: string; branch: string };
          return { kind: "push", label: "push と PR 作成は人が行います(PR本文の下書き: pr-draft.md)", command: `git -C ${p.repo} push origin ${p.branch}` };
        });
    default:
      return [];
  }
}
