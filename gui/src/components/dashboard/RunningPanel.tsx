import type { Overview } from "../../../../src/server/api-types.ts";
import { useEvents } from "../../lib/api.ts";
import { MILESTONE_KINDS, describeEvent, isMilestone, latestAction } from "../../lib/events.ts";
import { elapsedSec, formatDuration } from "../../lib/format.ts";
import { paths } from "../../lib/routes.ts";
import { Link } from "../../lib/router.tsx";
import { useNow } from "../../lib/useNow.ts";
import { EventList } from "../EventList.tsx";
import { Panel } from "../Panel.tsx";
import { PulseDot } from "../StateBadge.tsx";
import { Empty } from "../Status.tsx";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Running = Overview["running"][number];

/** 最後に動いてからこれを超えたら、注意の色にする(詰まっていないかの目安。止めはしない) */
const QUIET_SEC = 180;

/** 実行中(F2): 実行中の役割ごとに今の動き1行と、全タスクの最近の出来事(経緯の出来事だけ) */
export function RunningPanel({ running }: { running: Overview["running"] }) {
  const now = useNow(1000, running.length > 0);
  return (
    <Panel title="実行中" count={running.length} id="running-title">
      {running.length === 0 ? (
        <Empty>実行中の役割はありません</Empty>
      ) : (
        <div className="divide-y">
          {running.map((r) => (
            <RunningRow key={r.id} run={r} now={now} />
          ))}
        </div>
      )}
      <RecentMilestones />
    </Panel>
  );
}

function RunningRow({ run: r, now }: { run: Running; now: number }) {
  const { events } = useEvents({ run: r.id }, 30);
  const action = latestAction(events);
  const line = action && describeEvent(action);
  const quiet = elapsedSec(action?.createdAt ?? r.startedAt, now);
  return (
    <Link to={paths.run(r.id)} className="flex flex-col gap-1 px-4 py-3 no-underline hover:bg-muted max-sm:px-3">
      <span className="flex min-w-0 items-center gap-2">
        <Badge variant="running">
          <PulseDot />
          {r.role}
        </Badge>
        {r.model && <span className="text-xs text-muted-foreground">{r.model}</span>}
        <span className="min-w-0 flex-1 truncate text-xs">
          {r.taskId !== null ? (
            <>
              <span className="text-subtle-foreground tabular-nums">#{r.taskId}</span> {r.taskTitle}
            </>
          ) : (
            <span className="text-muted-foreground">プロジェクトの調査</span>
          )}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{formatDuration(elapsedSec(r.startedAt, now))}</span>
      </span>
      <span className="flex min-w-0 items-baseline gap-2 pl-1 text-xs">
        {line ? (
          <>
            <span className="font-semibold whitespace-nowrap text-muted-foreground">{line.title}</span>
            <span className={cn("min-w-0 flex-1 truncate", line.tone === "tool" && "font-mono")}>{line.text}</span>
          </>
        ) : (
          <span className="flex-1 text-muted-foreground">起動中…</span>
        )}
        <span className={cn("whitespace-nowrap tabular-nums", quiet > QUIET_SEC ? "font-semibold text-attn" : "text-subtle-foreground")}>{formatDuration(quiet)}前</span>
      </span>
    </Link>
  );
}

function RecentMilestones() {
  const { events, loading } = useEvents({ kinds: MILESTONE_KINDS }, 100);
  const shown = events.filter(isMilestone).slice(-10);
  return (
    <div className="border-t">
      <h3 className="m-0 px-4 pt-3 pb-1 text-xs font-semibold text-muted-foreground max-sm:px-3">最近の出来事</h3>
      <div className="pb-2">{loading && shown.length === 0 ? <Empty>読み込み中…</Empty> : <EventList events={shown} order="desc" showTask emptyText="まだありません" />}</div>
    </div>
  );
}
