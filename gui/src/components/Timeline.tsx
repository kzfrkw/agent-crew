import { ChevronRightIcon } from "lucide-react";
import type { ApprovalView, EventView, RunSummary } from "../../../src/server/api-types.ts";
import { MILESTONE_KINDS } from "../lib/events.ts";
import { useEvents } from "../lib/api.ts";
import { elapsedSec, formatCost, formatDuration, formatTime } from "../lib/format.ts";
import { paths } from "../lib/routes.ts";
import { Link } from "../lib/router.tsx";
import { APPROVAL_LABELS, HUMAN_APPROVALS, buildTimeline } from "../lib/timeline.ts";
import { useNow } from "../lib/useNow.ts";
import { EventRow } from "./EventList.tsx";
import { RunStateBadge, VerdictBadge } from "./StateBadge.tsx";
import { Empty } from "./Status.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

type Props = { runs: RunSummary[]; events: EventView[]; approvals: ApprovalView[]; reviewRounds: number };

/** S2 の経緯: タスクの経緯の出来事を読み込んで Timeline に渡す */
export function TaskTimeline({ taskId, ...rest }: Omit<Props, "events"> & { taskId: number }) {
  const { events } = useEvents({ task: taskId, kinds: MILESTONE_KINDS }, 500);
  return <Timeline events={events} {...rest} />;
}

/** 経緯(docs/skeleton.md S2): 実行・人の判断・なぜそうなったかの出来事を、古い順の1本にする。既定は畳む */
export function Timeline({ runs, events, approvals, reviewRounds }: Props) {
  const items = buildTimeline({ runs, events, approvals });
  const now = useNow(1000, runs.some((r) => r.state === "running"));
  return (
    <section>
      <Collapsible className="rounded-lg border bg-card">
        <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1 px-4 py-3 text-left max-sm:px-3">
          <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" aria-hidden />
          <span className="text-[15px] font-semibold">経緯</span>
          <span className="ml-2 text-xs text-muted-foreground tabular-nums">
            差し戻し {reviewRounds} 回・実行 {runs.length} 回
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t py-2">
          {items.length === 0 ? (
            <Empty>まだ何もありません</Empty>
          ) : (
            <ul className="m-0 list-none p-0 text-xs">
              {items.map((i) =>
                i.type === "event" ? (
                  <EventRow key={`e${i.event.id}`} event={i.event} />
                ) : i.type === "run" ? (
                  <RunRow key={`r${i.run.id}`} run={i.run} now={now} />
                ) : (
                  <ApprovalRow key={`a${i.approval.id}`} approval={i.approval} />
                ),
              )}
            </ul>
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/** EventRow と同じ列(時刻・印・中身) */
const ROW = "grid grid-cols-[64px_18px_minmax(0,1fr)] items-baseline gap-x-2 px-4 py-[3px] hover:bg-muted max-sm:grid-cols-[58px_16px_minmax(0,1fr)] max-sm:px-3";
const TIME = "font-mono text-[11.5px] text-subtle-foreground tabular-nums";

function RunRow({ run: r, now }: { run: RunSummary; now: number }) {
  const sec = r.state === "running" ? elapsedSec(r.startedAt, now) : r.durationSec;
  return (
    <li className={ROW}>
      <span className={TIME}>{formatTime(r.startedAt)}</span>
      <span className="text-center text-subtle-foreground" aria-hidden>
        ⚙
      </span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <Link to={paths.run(r.id)} className="font-semibold">
          {r.role}
        </Link>
        {r.model && <span className="text-muted-foreground">{r.model}</span>}
        {r.verdict ? <VerdictBadge verdict={r.verdict} /> : <RunStateBadge state={r.state} />}
        <span className="ml-auto text-muted-foreground tabular-nums">
          {formatCost(r.costUsd)} {formatDuration(sec)}
        </span>
      </span>
    </li>
  );
}

function ApprovalRow({ approval: a }: { approval: ApprovalView }) {
  const ok = a.result === "approved";
  const label = APPROVAL_LABELS[a.kind] ?? a.kind;
  const human = HUMAN_APPROVALS.includes(a.kind);
  return (
    <li className={cn(ROW, a.invalidatedAt && "opacity-55")}>
      <span className={TIME}>{formatTime(a.createdAt)}</span>
      <span className={cn("text-center", ok ? "text-run" : "text-destructive")} aria-hidden>
        {ok ? "✓" : "✗"}
      </span>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className={cn("font-semibold whitespace-nowrap", human ? "text-human" : "text-muted-foreground")}>{human ? `人 ${label}を${ok ? "承認" : "却下"}` : `${label}の${ok ? "合格" : "不合格"}`}</span>
        {a.comment && <span className="min-w-0 truncate" title={a.comment}>「{a.comment}」</span>}
        {a.invalidatedAt && <span className="text-muted-foreground">失効</span>}
      </span>
    </li>
  );
}
