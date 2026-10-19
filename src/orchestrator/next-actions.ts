import type { Db } from "../db/connection.ts";
import { getProject, getRepo, getTask, listEvents, listProjects, listRepos, listTaskRepos, type Task } from "../db/store.ts";
import { commitsSince } from "../git/worktree.ts";
import type { ApprovalKindView, Attention, NextAction } from "../server/api-types.ts";
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
    case "awaiting_design_approval":
      return "approve_design";
    case "awaiting_final_approval":
      return "approve_final";
    case "awaiting_strategy_approval":
    case "awaiting_scope_approval":
    case "awaiting_handoff_approval":
      return "approve_planning";
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

export function nextActions(db: Db, task: Pick<Task, "id" | "state"> & { design?: Task["design"]; heldFromState?: Task["heldFromState"]; kind?: Task["kind"] }): NextAction[] {
  const id = task.id;
  if (runActive(db, id)) {
    return [{ kind: "stop", label: "実行中の役割を停止する", command: null, request: { action: "stop" }, confirm: "実行中の claude を止めます。タスクは人の判断待ちになります" }];
  }
  const approval = (kind: ApprovalKindView, what: string): NextAction[] => [
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
    case "awaiting_plan_approval": {
      const [approve, reject] = approval("plan", "plan.md ");
      const design = task.design ?? { architect: false, designer: false };
      const plan = listEvents(db, id, 1000).filter((e) => e.kind === "plan").at(-1)?.payload as { design?: { reason?: string }; split?: { title: string }[] } | undefined;
      const reason = plan?.design?.reason;
      const split = (plan?.split ?? []).filter((s) => s.title?.trim());
      return [
        {
          ...approve!,
          // テスト基盤整備は画面を変えないので、設計者・デザイナーは選ばせない(動かさない)
          ...(task.kind === "test_infra"
            ? {}
            : {
                options: [
                  { key: "architect", label: "設計者を動かす(design.md)", value: design.architect },
                  { key: "designer", label: "デザイナーを動かす(ui-spec.md、UI を伴う変更)", value: design.designer },
                ],
                optionsNote: reason ? `プランナーの判断: ${reason}` : undefined,
              }),
          ...(split.length >= 2 ? { split: { count: split.length, titles: split.map((s) => s.title) } } : {}),
        },
        reject!,
      ];
    }
    case "awaiting_design_approval":
      return approval("design", "ui-spec.md ");
    case "awaiting_final_approval":
      // 承認の前に手元で変更を見られるように(見るだけ。直すなら「人が引き取る」)
      return [...approval("final", "成果物"), { kind: "open_editor", label: "エディタで開く(見るだけ)", command: null, request: { action: "open_editor" } }];
    case "awaiting_strategy_approval":
      return approval("strategy", "strategy.md(戦略)");
    case "awaiting_scope_approval":
      return approval("scope", "scope.md(要件)");
    case "awaiting_handoff_approval": {
      const [approve, reject] = approval("handoff", "handoff.md(開発のチケット)");
      const tickets = (listEvents(db, id, 2000).filter((e) => e.kind === "handoff").at(-1)?.payload as { tickets?: { title: string }[] } | undefined)?.tickets ?? [];
      const task0 = getTask(db, id)!;
      const projects = listProjects(db).filter((p) => listRepos(db, p.id).length > 0).map((p) => p.name);
      const own = getProject(db, task0.projectId)!.name;
      return [
        {
          ...approve!,
          label: `handoff.md を確認し、開発のチケット ${tickets.length} 件を作る`,
          optionsNote: tickets.map((t, i) => `${i + 1}. ${t.title}`).join(" / ") || undefined,
          targets: { projects, selected: projects.includes(own) ? own : null, ...(projects.includes(own) ? {} : { attachTo: own }) },
        },
        reject!,
      ];
    }
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
        // デザインレビューで止まったとき(撮影できないなど)は、やり直すだけでは進まないことがあるので出口を出す
        ...(task.heldFromState === "design_reviewing"
          ? ([
              {
                kind: "skip_design_review" as const,
                label: "デザインレビューを飛ばして最終確認へ",
                command: `agent-crew task skip-design-review ${id}`,
                request: { action: "skip_design_review" as const },
              },
              {
                kind: "back_to_implementer" as const,
                label: "実装者に差し戻す",
                command: `agent-crew task back-to-implementer ${id} --comment "..."`,
                request: { action: "back_to_implementer" as const, comment: "" },
                input: { field: "comment", required: true, placeholder: "差し戻す理由(例: 画面を撮るテスト integration_test/screens_test.dart を書いてください)" },
              },
            ] satisfies NextAction[])
          : []),
        takeover,
        ...updateBaseAction(db, id),
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
          const p = e.payload as { repo: string; branch: string; into?: string };
          // 新規開発で既定ブランチに取り込んだもの(integrate: main)は、既定ブランチを push する
          if (p.into) return { kind: "push", label: `${p.into} に取り込みました。push は人が行います`, command: `git -C ${p.repo} push origin ${p.into}`, request: null };
          return { kind: "push", label: "push と PR 作成は人が行います(PR本文の下書き: pr-draft.md)", command: `git -C ${p.repo} push origin ${p.branch}`, request: null };
        });
    default:
      return [];
  }
}

/**
 * 「main の最新を取り込む」(task update-base)。何が起きるかを確認のダイアログで説明する:
 * タスクのコミットがまだ無ければ作り直し、あればマージする(実装の後ならレビューからやり直す)。worktree が無ければ出さない
 */
function updateBaseAction(db: Db, id: number): NextAction[] {
  const trs = listTaskRepos(db, id);
  if (trs.length === 0) return [];
  const branches = [...new Set(trs.map((tr) => getRepo(db, tr.repoId)!.defaultBranch))].join(" / ");
  const empty = trs.every((tr) => {
    try {
      return commitsSince(tr.worktreePath, tr.baseSha).length === 0;
    } catch {
      return false;
    }
  });
  return [
    {
      kind: "update_base",
      label: `${branches} の最新を取り込む`,
      command: `agent-crew task update-base ${id}`,
      request: { action: "update_base" },
      confirm: empty
        ? `このタスクのブランチにはまだコミットが無いので、最新の ${branches} から作り直します(失うものはありません)。${branches} の履歴が置き換わったとき(GitHub で作った最初のコミットなど)もこれで追従できます。状態は変わりません`
        : `最新の ${branches} を、このタスクのブランチにマージします。実装の後の段階なら、変更の前提が変わるのでレビューからやり直します。衝突したら人の作業(引き取って worktree で解決)になります`,
    },
  ];
}
