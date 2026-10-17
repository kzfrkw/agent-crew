import type { ApprovalView, EventView, RunSummary } from "../../../src/server/api-types.ts";
import { isMilestone } from "./events.ts";

/** タスクの経緯(docs/skeleton.md S2)の1行。副作用なし */
export type TimelineItem =
  | { type: "run"; at: string; run: RunSummary }
  | { type: "approval"; at: string; approval: ApprovalView }
  | { type: "event"; at: string; event: EventView };

/** 承認・合格の種類の表示名(S2 の経緯と「承認・合格」の欄) */
export const APPROVAL_LABELS: Record<string, string> = { plan: "計画", design: "デザイン", final: "最終確認", strategy: "戦略", scope: "要件", handoff: "引き渡し", review: "レビュー", qa: "QA", tests: "テストの再実行" };

/** 人が承認・却下するもの(ほかはツールが記録する合格) */
export const HUMAN_APPROVALS = ["plan", "design", "final", "strategy", "scope", "handoff"];

/** 同じ時刻なら、実行(の開始)→ 人の判断 → 出来事の順 */
const ORDER: Record<TimelineItem["type"], number> = { run: 0, approval: 1, event: 2 };

/** 実行・人の判断・経緯の出来事を古い順の1本にする。経緯に出さない出来事は落とす */
export function buildTimeline(x: { runs: RunSummary[]; events: EventView[]; approvals: ApprovalView[] }): TimelineItem[] {
  const items: TimelineItem[] = [
    ...x.runs.map((run) => ({ type: "run" as const, at: run.startedAt, run })),
    ...x.approvals.map((approval) => ({ type: "approval" as const, at: approval.createdAt, approval })),
    ...x.events.filter(isMilestone).map((event) => ({ type: "event" as const, at: event.createdAt, event })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at) || ORDER[a.type] - ORDER[b.type] || idOf(a) - idOf(b));
}

const idOf = (i: TimelineItem) => (i.type === "run" ? i.run.id : i.type === "approval" ? i.approval.id : i.event.id);
